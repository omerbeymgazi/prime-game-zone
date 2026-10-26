const crypto = require('crypto');
const { getPool } = require('./db');

const COLLECTIONS = new Set(['tournaments', 'registrations', 'players', 'counters']);
const HIDDEN_FIELDS = {
    registrations: ['receiptData'],
    players: ['passwordHash'],
};

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getPath(value, key) {
    return key.split('.').reduce((current, part) => current == null ? undefined : current[part], value);
}

function setPath(value, key, nextValue) {
    const parts = key.split('.');
    let current = value;
    for (const part of parts.slice(0, -1)) {
        if (!current[part] || typeof current[part] !== 'object') current[part] = {};
        current = current[part];
    }
    current[parts[parts.length - 1]] = clone(nextValue);
}

function sameValue(left, right) {
    if (left === right) return true;
    if (left == null || right == null) return left === right;
    return String(left) === String(right);
}

function matchesValue(actual, condition) {
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
        return sameValue(actual, condition);
    }
    const operators = Object.keys(condition);
    if (!operators.some((key) => key.startsWith('$'))) return sameValue(actual, condition);

    return operators.every((operator) => {
        const expected = condition[operator];
        switch (operator) {
            case '$in':
                return expected.some((item) => sameValue(actual, item));
            case '$ne':
                return !sameValue(actual, expected);
            case '$gt':
                return actual > expected;
            case '$gte':
                return actual >= expected;
            case '$lt':
                return actual < expected;
            case '$lte':
                return actual <= expected;
            case '$exists':
                return (actual !== undefined) === expected;
            default:
                throw new Error(`Unsupported MySQL store query operator: ${operator}`);
        }
    });
}

function matches(row, filter = {}) {
    return Object.entries(filter).every(([key, condition]) => {
        if (key === '$or') return condition.some((item) => matches(row, item));
        if (key === '$and') return condition.every((item) => matches(row, item));
        return matchesValue(getPath(row, key), condition);
    });
}

function applyUpdate(row, update) {
    const operators = Object.keys(update);
    const changes = operators.some((key) => key.startsWith('$')) ? update : { $set: update };
    for (const [key, value] of Object.entries(changes.$set || {})) setPath(row, key, value);
    for (const [key, value] of Object.entries(changes.$inc || {})) {
        setPath(row, key, (getPath(row, key) || 0) + value);
    }
    for (const key of Object.keys(changes.$unset || {})) {
        const parts = key.split('.');
        const parent = getPath(row, parts.slice(0, -1).join('.'));
        if (parent) delete parent[parts[parts.length - 1]];
    }
}

function parseDocument(document) {
    return typeof document === 'string' ? JSON.parse(document) : document;
}

class MySqlDocument {
    constructor(model, value) {
        Object.defineProperty(this, '_model', { value: model });
        Object.assign(this, clone(value));
    }

    get id() {
        return this._id;
    }

    toObject() {
        return clone(Object.fromEntries(Object.entries(this)));
    }

    async save() {
        await this._model.save(this.toObject());
        return this;
    }

    async deleteOne() {
        const pool = getPool();
        await pool.execute(`DELETE FROM \`${this._model.tableName}\` WHERE id = ?`, [String(this._id)]);
        return { deletedCount: 1 };
    }
}

class MySqlQuery {
    constructor(model, filter, single = false) {
        this.model = model;
        this.filter = filter;
        this.single = single;
        this.sortOrder = null;
        this.maximum = null;
        this.selection = null;
        this.asPlainObject = false;
    }

    sort(order) {
        this.sortOrder = order;
        return this;
    }

    limit(count) {
        this.maximum = count;
        return this;
    }

    select(fields) {
        this.selection = fields;
        return this;
    }

    lean() {
        this.asPlainObject = true;
        return this;
    }

    async exec() {
        let rows = (await this.model.findRows()).filter((row) => matches(row, this.filter));
        if (this.sortOrder) {
            const ordering = Object.entries(this.sortOrder);
            rows = [...rows].sort((left, right) => {
                for (const [key, direction] of ordering) {
                    const a = getPath(left, key);
                    const b = getPath(right, key);
                    if (a === b) continue;
                    if (a == null) return -direction;
                    if (b == null) return direction;
                    if (a < b) return -direction;
                    if (a > b) return direction;
                }
                return 0;
            });
        }
        if (this.maximum !== null) rows = rows.slice(0, this.maximum);
        const results = rows.map((row) => this.model.project(row, this.selection, this.asPlainObject));
        return this.single ? results[0] || null : results;
    }

    then(resolve, reject) {
        return this.exec().then(resolve, reject);
    }

    catch(reject) {
        return this.exec().catch(reject);
    }
}

class MySqlModel {
    constructor(collectionName, { timestamps = true, defaults = {}, unique = [] } = {}) {
        if (!COLLECTIONS.has(collectionName)) throw new Error(`Unknown MySQL collection: ${collectionName}`);
        this.collectionName = collectionName;
        this.tableName = `pgz_${collectionName}`;
        this.timestamps = timestamps;
        this.defaults = defaults;
        this.uniqueFields = unique;
    }

    prepare(value, isNew = false) {
        const now = new Date().toISOString();
        const prepared = { ...clone(this.defaults), ...clone(value) };
        if (!prepared._id && this.collectionName !== 'counters') {
            prepared._id = crypto.randomBytes(12).toString('hex');
        }
        if (this.timestamps) {
            if (isNew && !prepared.createdAt) prepared.createdAt = now;
            if (!prepared.updatedAt) prepared.updatedAt = now;
        }
        return prepared;
    }

    uniqueValues(document) {
        const values = this.uniqueFields.map((field) => document[field] ?? null);
        while (values.length < 3) values.push(null);
        return values;
    }

    async save(document, connection = getPool()) {
        const [existing] = await connection.execute(
            `SELECT id FROM \`${this.tableName}\` WHERE id = ?`,
            [String(document._id)]
        );
        const value = this.prepare(document, existing.length === 0);
        const [first, second, third] = this.uniqueValues(value);
        if (existing.length) {
            await connection.execute(
                `UPDATE \`${this.tableName}\`
                 SET document = ?, unique_1 = ?, unique_2 = ?, unique_3 = ?
                 WHERE id = ?`,
                [JSON.stringify(value), first, second, third, String(value._id)]
            );
        } else {
            await connection.execute(
                `INSERT INTO \`${this.tableName}\` (id, document, unique_1, unique_2, unique_3)
                 VALUES (?, ?, ?, ?, ?)`,
                [String(value._id), JSON.stringify(value), first, second, third]
            );
        }
        Object.assign(document, value);
        return document;
    }

    async findRows(connection = getPool(), forUpdate = false) {
        const [rows] = await connection.query(
            `SELECT document FROM \`${this.tableName}\`${forUpdate ? ' FOR UPDATE' : ''}`
        );
        return rows.map((row) => parseDocument(row.document));
    }

    async withTransaction(callback) {
        const connection = await getPool().getConnection();
        try {
            await connection.beginTransaction();
            const result = await callback(connection);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    project(value, selection, asPlainObject) {
        const result = clone(value);
        const hidden = HIDDEN_FIELDS[this.collectionName] || [];
        for (const field of hidden) {
            if (!selection?.split(/\s+/).includes(`+${field}`)) delete result[field];
        }
        if (selection) {
            const selected = selection.split(/\s+/).filter((field) => field && !field.startsWith('+'));
            if (selected.length && !selection.startsWith('+')) {
                const projected = {};
                for (const field of selected) {
                    if (Object.prototype.hasOwnProperty.call(result, field)) projected[field] = result[field];
                }
                if (Object.prototype.hasOwnProperty.call(result, '_id')) projected._id = result._id;
                return asPlainObject ? projected : new MySqlDocument(this, projected);
            }
        }
        return asPlainObject ? result : new MySqlDocument(this, result);
    }

    find(filter = {}) {
        return new MySqlQuery(this, filter);
    }

    findOne(filter = {}) {
        return new MySqlQuery(this, filter, true);
    }

    findById(id) {
        return this.findOne({ _id: id });
    }

    async exists(filter = {}) {
        const found = await this.findOne(filter);
        return found ? { _id: found._id } : null;
    }

    async countDocuments(filter = {}) {
        return (await this.findRows()).filter((row) => matches(row, filter)).length;
    }

    async create(value) {
        const document = this.prepare(value, true);
        await this.save(document);
        return new MySqlDocument(this, document);
    }

    async insertMany(values) {
        const inserted = [];
        for (const value of values) inserted.push(await this.create(value));
        return inserted;
    }

    async findOneAndUpdate(filter, update, options = {}) {
        const pool = getPool();
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const rows = await this.findRows(connection, true);
            let row = rows.find((item) => matches(item, filter));
            if (!row && options.upsert) {
                const seed = Object.fromEntries(Object.entries(filter).filter(([, value]) => (
                    value === null || typeof value !== 'object'
                )));
                row = this.prepare(seed, true);
                if (options.setDefaultsOnInsert) Object.assign(row, clone(this.defaults));
                applyUpdate(row, update);
                await this.save(row, connection);
                await connection.commit();
                return new MySqlDocument(this, row);
            }
            if (!row) {
                await connection.commit();
                return null;
            }
            const before = clone(row);
            applyUpdate(row, update);
            if (this.timestamps) row.updatedAt = new Date().toISOString();
            await this.save(row, connection);
            await connection.commit();
            return new MySqlDocument(this, options.new ? row : before);
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async findByIdAndUpdate(id, update, options = {}) {
        return this.findOneAndUpdate({ _id: id }, update, options);
    }

    async updateMany(filter, update) {
        const connection = await getPool().getConnection();
        try {
            await connection.beginTransaction();
            const rows = (await this.findRows(connection, true)).filter((row) => matches(row, filter));
            for (const row of rows) {
                applyUpdate(row, update);
                if (this.timestamps) row.updatedAt = new Date().toISOString();
                await this.save(row, connection);
            }
            await connection.commit();
            return { acknowledged: true, matchedCount: rows.length, modifiedCount: rows.length };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async updateOne(filter, update) {
        const row = (await this.findRows()).find((item) => matches(item, filter));
        if (!row) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
        applyUpdate(row, update);
        if (this.timestamps) row.updatedAt = new Date().toISOString();
        await this.save(row);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }

    async deleteMany(filter) {
        const pool = getPool();
        const rows = (await this.findRows()).filter((row) => matches(row, filter));
        if (!rows.length) return { acknowledged: true, deletedCount: 0 };
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            for (const row of rows) {
                await connection.execute(`DELETE FROM \`${this.tableName}\` WHERE id = ?`, [String(row._id)]);
            }
            await connection.commit();
            return { acknowledged: true, deletedCount: rows.length };
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async aggregate(pipeline) {
        const group = pipeline.find((stage) => stage.$group)?.$group;
        if (!group || typeof group._id !== 'string' || !group._id.startsWith('$')) {
            throw new Error('Unsupported MySQL store aggregation pipeline.');
        }
        const field = group._id.slice(1);
        const countName = Object.keys(group).find((key) => group[key]?.$sum === 1);
        if (!countName) throw new Error('Unsupported MySQL store aggregation count.');
        const counts = new Map();
        for (const row of await this.findRows()) {
            const key = getPath(row, field);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        return [...counts].map(([key, count]) => ({ _id: key, [countName]: count }));
    }
}

function isValidObjectId(value) {
    return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

module.exports = { MySqlModel, isValidObjectId };
