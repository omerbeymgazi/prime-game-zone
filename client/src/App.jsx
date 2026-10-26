import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './App.css'
import AdminDashboard from './components/AdminDashboard.jsx'
import LoadingScreen from './components/LoadingScreen.jsx'
import LeaderboardPanel from './components/LeaderboardPanel.jsx'
import PlayerDisputeForm from './components/PlayerDisputeForm.jsx'
import StaffConsole from './components/StaffConsole.jsx'
import PlayerSupportChat from './components/PlayerSupportChat.jsx'

const API_BASE = '/api'
const SUPPORT_TELEGRAM = (import.meta.env.VITE_SUPPORT_TELEGRAM || '').replace(/^@/, '')

function tournamentDisplayName(weekId) {
  return `Prime Ethiopia Cup ${weekId + 1}`
}

let feedbackAudioContext

function playInteractionFeedback() {
  if (navigator.vibrate) navigator.vibrate(8)
  if (!window.AudioContext) return
  try {
    feedbackAudioContext ||= new window.AudioContext()
    if (feedbackAudioContext.state === 'suspended') feedbackAudioContext.resume()
    const oscillator = feedbackAudioContext.createOscillator()
    const gain = feedbackAudioContext.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 660
    gain.gain.setValueAtTime(0.018, feedbackAudioContext.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, feedbackAudioContext.currentTime + 0.035)
    oscillator.connect(gain)
    gain.connect(feedbackAudioContext.destination)
    oscillator.start()
    oscillator.stop(feedbackAudioContext.currentTime + 0.04)
  } catch (error) {
    console.warn('Interaction audio could not be played:', error.message)
  }
}

async function playerRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`)
  return data
}

function copyTextToClipboard(value) {
  const input = document.createElement('textarea')
  input.value = value
  input.setAttribute('readonly', '')
  input.setAttribute('aria-hidden', 'true')
  input.style.position = 'fixed'
  input.style.top = '0'
  input.style.left = '-9999px'
  input.style.opacity = '0'
  document.body.appendChild(input)
  try {
    input.focus()
    input.select()
    input.setSelectionRange(0, input.value.length)
    return typeof document.execCommand === 'function' && document.execCommand('copy')
  } finally {
    input.remove()
  }
}

async function writeClipboardText(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return copyTextToClipboard(text)
    }
  }
  return copyTextToClipboard(text)
}

function mapTournamentSchedule(weeks) {
  return weeks.map((week) => ({
    id: week.weekId,
    name: tournamentDisplayName(week.weekId),
    dateRange: week.dateRange,
    capacity: week.capacity,
    remaining: week.availableSlots,
    filled: week.capacity - week.availableSlots,
    entryFee: week.entryFee ?? 1500,
    prizePool: week.prizePool ?? 20000,
    status: week.status,
  }))
}

let groupParticipantSequence = 0

function createEmptyGroupParticipant() {
  return {
    id: window.crypto?.randomUUID?.() || `group-player-${Date.now()}-${++groupParticipantSequence}`,
    playerName: '',
    contact: '',
    telegramUsername: '',
    sessionPreference: 'any',
  }
}

const tournament = {
  name: 'Prime Ethiopia Cup',
  games: 'EA SPORTS FC 26',
  platforms: 'PS4 / PS5',
  format: '1v1 Knockout',
  slots: 32,
  remaining: 14,
  entryFee: '1,500 ETB',
  prizePool: '20,000 ETB',
}

const prizes = [
  { place: '1st', medal: '🥇', className: 'gold' },
  { place: '2nd', medal: '🥈', className: 'silver' },
  { place: '3rd', medal: '🥉', className: 'bronze' },
  { place: '4th', medal: '🏅', className: 'fourth' },
]

const payments = [
  { id: 'telebirr', name: 'Telebirr', mark: 'T', image: '/Telebirr.png', detail: 'Mobile money' },
  { id: 'cbe', name: 'Commercial Bank of Ethiopia', shortName: 'CBE', mark: 'C', image: '/commercial-bank-of-ethiopia-logo-png_seeklogo-547506.png', detail: 'Bank transfer' },
  { id: 'cash', name: 'Cash', mark: 'ETB', detail: 'In-person payment' },
]

const tabs = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'tournament', label: 'Tournament', icon: 'trophy' },
  { id: 'register', label: 'Register', icon: 'ticket' },
  { id: 'profile', label: 'Profile', icon: 'user' },
]

const translations = {
  EN: {
    login: 'Login / Register',
    signIn: 'Player sign in',
    registerAccount: 'Create player account',
    displayName: 'Player name',
    phone: 'Phone number',
    password: 'Password',
    telegramUsername: 'Telegram username',
    cash: 'Cash',
    psnId: 'PSN GamerTag',
    psnCode: 'PS Code',
    continue: 'Continue',
    createAccount: 'Create account',
    localProfile: 'Your player profile and tournament history are saved securely.',
    noAccount: "Don't have an account? Register",
    haveAccount: 'Already registered? Login',
    forgotPassword: 'Forgot Password? Contact Support',
    supportContact: 'Open Telegram to contact the tournament organizer.',
    home: 'Home',
    tournamentTab: 'Tournament',
    registerTab: 'Register',
    profileTab: 'Profile',
    psnOnly: 'PLAYSTATION ONLY',
    heroKicker: 'THE NEXT LEVEL STARTS HERE',
    heroSubhead: 'Built for players. Made for the competition.',
    exploreCup: 'Explore the cup',
    tickerOpen: 'NOW OPEN · PRIME ETHIOPIA CUP',
    prizePoolLabel: 'PRIZE POOL',
    nextMatch: 'YOUR NEXT MATCH',
    chooseZone: 'Your Next Match',
    servicesSubhead: 'Our Services',
    leagues: 'PS5 / PS4 Leagues',
    leaguesDetail: 'Local in-person competition',
    tournaments: 'Tournaments',
    tournamentsDetail: 'Compete for prizes',
    friendly: 'Friendly Zone',
    friendlyDetail: 'Local matches, good vibes',
    official: 'Official Services',
    officialDetail: 'PRIME GAMING Ethiopia',
    capacity: 'TOURNAMENT CAPACITY',
    slotsRemaining: 'slots remaining',
    claimSpot: 'Claim your spot',
    cup: 'Prime Ethiopia Cup',
    prizeBreakdown: 'Prize Breakdown',
    prizePool: '20,000 ETB prize pool',
    entryFee: 'Entry Fee',
    register: 'Register for',
    registerNow: 'Register Now',
    firstPlace: '1st Place',
    secondPlace: '2nd Place',
    thirdPlace: '3rd Place',
    fourthPlace: '4th Place',
    champion: 'CHAMPION',
    runnerUp: 'RUNNER-UP',
    thirdAward: '3RD PLACE',
    fourthAward: '4TH PLACE',
    place: 'PLACE',
    nationalSeries: 'THE NATIONAL ESPORTS SERIES',
    tournamentSubtitle: 'EA SPORTS FC 26 · PS4 / PS5 · 1v1 knockout',
    entryFeeLabel: 'ENTRY FEE',
    championshipPrizePool: 'CHAMPIONSHIP PRIZE POOL',
    competeForTop: 'COMPETE FOR THE TOP',
    totalPrizePool: 'prize pool',
    availableTournaments: 'Available tournaments',
    cupSeries: 'PRIME ETHIOPIA CUP',
    cardEntryFee: 'ENTRY FEE',
    cardPrizePool: 'PRIZE POOL',
    cardFormat: '1v1 KNOCKOUT',
    spotsLeftShort: 'SPOTS LEFT',
    filledShort: 'FILLED',
    detailsFixtures: 'See details & fixtures',
    hideDetails: 'Hide details',
    gameLabel: 'Game',
    platformsLabel: 'Platforms',
    formatLabel: 'Format',
    registrationLabel: 'Registration',
    spotsLabel: 'Spots',
    fixturesMatchups: 'Fixtures & matchups',
    loadingFixtures: 'Loading the latest bracket…',
    drawNotPublished: 'The tournament draw and match pairings will appear here when published.',
    vs: 'VS',
    finalScore: 'Final score',
    round: 'Round',
    unknownPlayer: 'TBD',
    registrationOpen: 'REGISTRATION OPEN',
    info: 'TOURNAMENT INFO',
    rules: 'Rules & match settings',
    seeRules: 'See More',
    rulesTitle: 'Official tournament rules',
    halfLength: 'Half length',
    mode: 'Match mode',
    tactics: 'Tactics & formations',
    allowed: 'Custom allowed',
    format: 'Format',
    knockoutFormat: '1v1 Knockout · PS4 / PS5',
    kickoff: 'Kick-off',
    minutes: 'minutes',
    slots: 'players',
    strictPolicy: 'STRICT ANTI-GAMBLING POLICY',
    antiGambling: 'Any form of gambling, betting, or illegal wagering is STRICTLY PROHIBITED. Violations result in an immediate lifetime ban and forfeiture of entry fees.',
    close: 'Close',
    open: 'OPEN',
    slotsLeft: 'slots left',
    introKicker: '32 SLOTS · ONE CHAMPION',
    introTitle: 'Lock in your spot.',
    introDescription: 'Enter your player details and choose how you’ll pay.',
    entryBanner: 'PRIME ETHIOPIA CUP · ENTRY FEE',
    playerDetails: 'Player details',
    playerName: 'Player name',
    playerNamePlaceholder: 'Name for tournament roster',
    contactLabel: 'Player phone number',
    contactPlaceholder: '+251 9XX XXX XXX',
    fullNameLabel: 'Full Name / Player Name',
    phonePlaceholder: '+251 9XX XXX XXX',
    contactSummary: 'Phone number',
    paymentMethod: 'Choose payment method',
    paymentLabel: 'Payment method',
    mobileMoney: 'Mobile money',
    bankTransfer: 'Bank transfer',
    inPersonPayment: 'In-person payment',
    paymentDisclaimer: 'Secure your slot after the organizer confirms your payment. No payment is collected in this app.',
    receiptUpload: 'Upload payment receipt (required)',
    receiptInvalid: 'Choose a PNG, JPG, or WebP receipt under 5 MB.',
    scheduleLoadError: 'Live tournament availability is temporarily unavailable.',
    proceedPayment: 'Proceed to Payment & Confirm Registration',
    savedRegistration: 'Registration request saved.',
    followUp: 'Follow up with the tournament organizer to complete payment and confirm your slot.',
    profileHub: 'PLAYER HUB',
    matchCenter: 'Your match center.',
    profileDescription: 'Player identity, registration and the road to the final.',
    primePlayer: 'PRIME GAMING PLAYER',
    psnNotConnected: 'PSN ID not connected',
    online: 'ONLINE',
    player: 'PLAYER',
    profileSettings: 'Profile settings',
    playerAccount: 'PLAYER ACCOUNT',
    playerId: 'PLAYER ID',
    myTournaments: 'My tournaments',
    notificationTitle: 'Notifications',
    markAllRead: 'Mark all read',
    noNotifications: 'You are all caught up.',
    notificationsLoading: 'Loading notifications…',
    notificationsError: 'Notifications could not be loaded.',
    notificationSignIn: 'Sign in to view your notifications.',
    accountMenu: 'Player account actions',
    deleteConfirmTitle: 'Delete your account?',
    cancel: 'Cancel',
    playerCode: 'Player Code',
    copyCode: 'Copy code',
    copied: 'Copied!',
    editProfile: 'Edit profile',
    saveProfile: 'Save profile',
    deleteAccount: 'Delete account',
    deleteAccountPrompt: 'Enter your password to permanently delete your player account and registrations.',
    deleteAccountConfirm: 'Permanently delete account?',
    profileSaved: 'Profile updated.',
    profileUpdateError: 'Profile update failed.',
    noBracketYet: 'The organizer has not published fixtures for this tournament yet.',
    fullyBooked: 'Fully Booked',
    spotsLeftLabel: 'Spots left',
    statusUpcoming: 'UPCOMING',
    statusLive: 'LIVE',
    statusCompleted: 'COMPLETED',
    roundOf32: 'ROUND OF 32',
    roundOf16: 'ROUND OF 16',
    quarterFinals: 'QUARTER-FINALS',
    semiFinals: 'SEMI-FINALS',
    final: 'FINAL',
    uploadAvatar: 'Upload profile picture',
    weeklySchedule: 'Weekly Tournament Schedule',
    selectWeek: 'Choose an upcoming tournament week',
    week: 'Week',
    tournament: 'Tournament',
    slotsLeftOf: 'Slots Left / 32 Total',
    spotsFilled: 'Spots Filled',
    spotsRemaining: 'Spots Remaining',
    weekCardHint: 'Tournament details',
    weekDetails: 'Tournament details',
    registerWeek: 'Register Now for',
    registrationWeek: 'Selected tournament',
    halfTimeRule: '4-minute halves',
    kickoffRule: 'Kick-off mode',
    formationsRule: 'Custom formations allowed',
    weekOpen: 'OPEN',
    weekFull: 'FULL',
    weekLive: 'LIVE',
    weekCompleted: 'COMPLETED',
    registrationClosed: 'Registration closed',
    selectedWeek: 'Selected tournament',
    dailyHours: 'Daily match hours',
    scheduleHours: '8:00 AM – 3:00 PM',
    matchesPerDay: 'Players may be scheduled for 2 to 4 in-person matches per day at the venue.',
    registeredWeek: 'Selected week',
    generatedPsCode: 'PS Code',
    signOut: 'Sign out',
    competition: 'YOUR COMPETITION',
    registeredTournaments: 'Registered tournaments',
    paymentPending: 'PAYMENT PENDING',
    noRegistrations: 'No tournament registrations yet',
    nextCompetition: 'Your next competition starts here.',
    exploreRegistration: 'Explore registration',
    roadToCup: 'THE ROAD TO THE CUP',
    matchBracket: 'Match bracket',
    knockout: '32-PLAYER KNOCKOUT',
    preview: 'PREVIEW',
    yourPsn: 'Your PSN ID',
    opponent: 'Opponent',
    winnerR32: 'Winner R32',
    matchupNotice: 'Matchups will be announced by the tournament organizer.',
    needHelp: 'NEED A HAND?',
    contactSupport: 'Tournament contact center',
    supportDescription: 'Contact the tournament admins on Telegram for help with registration, payment, or fixtures.',
    contactAdmin: 'Contact admins on Telegram',
    supportUnavailable: 'Admin contact is currently unavailable. Please try again later.',
    footer: '© 2026 PRIME GAMING Ethiopia. All Rights Reserved.',
    loading: 'Loading Match Data...',
    connecting: 'Reconnecting to PlayStation Network...',
    connectionInterrupted: 'CONNECTION INTERRUPTED',
    brandDetail: 'PRIME GAMING · ETHIOPIA',
    localServices: 'In-person & local matches only',
  },
  ET: {
    login: 'ግባ / ተመዝገብ',
    signIn: 'ወደ ተጫዋች መለያ ግባ',
    registerAccount: 'የተጫዋች መለያ ፍጠር',
    displayName: 'የተጫዋች ስም',
    phone: 'ስልክ ቁጥር',
    password: 'የይለፍ ቃል',
    telegramUsername: 'የቴሌግራም የተጠቃሚ ስም',
    cash: 'በጥሬ ገንዘብ',
    psnId: 'PSN የተጫዋች መለያ',
    psnCode: 'የPS ኮድ',
    continue: 'ቀጥል',
    createAccount: 'መለያ ፍጠር',
    localProfile: 'የተጫዋች መገለጫዎ እና የውድድር ታሪክዎ በደህና ይቀመጣሉ።',
    noAccount: 'መለያ የለዎትም? ይመዝገቡ',
    haveAccount: 'አስቀድመው ተመዝግበዋል? ይግቡ',
    forgotPassword: 'የይለፍ ቃል ረሱ? ድጋፍን ያግኙ',
    supportContact: 'የውድድሩን አዘጋጅ ለማግኘት ቴሌግራምን ይክፈቱ።',
    home: 'መነሻ',
    tournamentTab: 'ውድድር',
    registerTab: 'ምዝገባ',
    profileTab: 'መገለጫ',
    psnOnly: 'PlayStation ብቻ',
    heroKicker: 'ቀጣዩ ደረጃ እዚህ ይጀምራል',
    heroSubhead: 'ለተጫዋቾች የተሰራ፣ ለውድድር የተዘጋጀ።',
    exploreCup: 'ውድድሩን ይመልከቱ',
    tickerOpen: 'ምዝገባ ተከፍቷል · ፕራይም ኢትዮጵያ ካፕ',
    prizePoolLabel: 'ጠቅላላ ሽልማት',
    nextMatch: 'ቀጣዩ ጨዋታዎ',
    chooseZone: 'ቀጣይ ጨዋታዎ',
    servicesSubhead: 'አገልግሎቶቻችን',
    leagues: 'PS5 / PS4 ሊጎች',
    leaguesDetail: 'በአካል የሚደረግ ውድድር',
    tournaments: 'ውድድሮች',
    tournamentsDetail: 'ለሽልማት ይወዳደሩ',
    friendly: 'የወዳጅነት ክፍል',
    friendlyDetail: 'በአካባቢ ጨዋታ፣ በደስታ',
    official: 'ኦፊሴላዊ አገልግሎቶች',
    officialDetail: 'ፕራይም ጌሚንግ ኢትዮጵያ',
    capacity: 'የውድድር አቅም',
    slotsRemaining: 'ቦታዎች ቀርተዋል',
    claimSpot: 'ቦታዎን ያስይዙ',
    cup: 'ፕራይም ኢትዮጵያ ካፕ',
    prizeBreakdown: 'የሽልማት ክፍፍል',
    prizePool: '20,000 ETB ጠቅላላ ሽልማት',
    entryFee: 'የመግቢያ ክፍያ',
    register: 'ለመመዝገብ',
    registerNow: 'አሁኑኑ ይመዝገቡ',
    firstPlace: '1ኛ ደረጃ',
    secondPlace: '2ኛ ደረጃ',
    thirdPlace: '3ኛ ደረጃ',
    fourthPlace: '4ኛ ደረጃ',
    champion: 'አሸናፊ',
    runnerUp: 'ምክትል',
    thirdAward: 'ነሐስ',
    fourthAward: '4ኛ ደረጃ',
    place: 'ደረጃ',
    nationalSeries: 'የኢትዮጵያ ብሔራዊ ኤስፖርት ውድድር',
    tournamentSubtitle: 'EA SPORTS FC 26 · PS4 / PS5 · አንድ ተጫዋች ከአንድ ተጫዋች ጋር',
    entryFeeLabel: 'የመግቢያ ክፍያ',
    championshipPrizePool: 'ጠቅላላ የሻምፒዮና ሽልማት',
    competeForTop: 'ለዋንጫው ይወዳደሩ',
    totalPrizePool: 'ጠቅላላ ሽልማት',
    availableTournaments: 'የሚገኙ ውድድሮች',
    cupSeries: 'ፕራይም ኢትዮጵያ ካፕ',
    cardEntryFee: 'የመግቢያ ክፍያ',
    cardPrizePool: 'የሽልማት ገንዘብ',
    cardFormat: 'አንድ ለአንድ · የማስወገድ ውድድር',
    spotsLeftShort: 'የቀሩ ቦታዎች',
    filledShort: 'የተያዙ',
    detailsFixtures: 'ዝርዝርና የጨዋታ መርሐግብር',
    hideDetails: 'ዝርዝሩን ደብቅ',
    gameLabel: 'ጨዋታ',
    platformsLabel: 'መድረኮች',
    formatLabel: 'የውድድር አይነት',
    registrationLabel: 'ምዝገባ',
    spotsLabel: 'ቦታዎች',
    fixturesMatchups: 'የጨዋታ መርሐግብርና ተጋጣሚዎች',
    loadingFixtures: 'የቅርብ ጊዜው የጨዋታ ድልድል በመጫን ላይ…',
    drawNotPublished: 'የውድድር ድልድሉና ተጋጣሚዎቹ ሲዘጋጁ እዚህ ይታያሉ።',
    vs: 'ከ',
    finalScore: 'የመጨረሻ ውጤት',
    round: 'ዙር',
    unknownPlayer: 'ተጫዋች አልተመደበም',
    registrationOpen: 'ምዝገባ ተከፍቷል',
    info: 'የውድድር መረጃ',
    rules: 'ህጎች እና የጨዋታ ቅንብሮች',
    seeRules: 'ህግጋት',
    rulesTitle: 'የውድድር ህጎች',
    halfLength: 'የእያንዳንዱ አጋማሽ ርዝመት',
    mode: 'የጨዋታ ሁኔታ',
    tactics: 'ታክቲክ እና አሰላለፍ',
    allowed: 'ብጁ አሰላለፍ ይፈቀዳል',
    format: 'የውድድር አይነት',
    knockoutFormat: '1v1 የማስወገድ ውድድር · PS4 / PS5',
    kickoff: 'የመነሻ ጨዋታ',
    minutes: 'ደቂቃ',
    slots: 'ተጫዋቾች',
    strictPolicy: 'ጥብቅ የቁማር መከላከያ ፖሊሲ',
    antiGambling: 'ማንኛውም የቁማር፣ ውርርድ ወይም ህገወጥ የገንዘብ ውርርድ በጥብቅ የተከለከለ ነው። ጥሰት ወዲያውኑ የዕድሜ ልክ እገዳን እና የመግቢያ ክፍያ መቀጮን ያስከትላል።',
    close: 'ዝጋ',
    open: 'ክፍት',
    slotsLeft: 'ቦታዎች ቀርተዋል',
    introKicker: '32 ቦታዎች · አንድ አሸናፊ',
    introTitle: 'ቦታዎን ያስይዙ።',
    introDescription: 'የተጫዋች መረጃዎን ያስገቡ እና የክፍያ መንገድ ይምረጡ።',
    entryBanner: 'ፕራይም ኢትዮጵያ ካፕ · የመግቢያ ክፍያ',
    playerDetails: 'የተጫዋች መረጃ',
    playerName: 'የተጫዋች ስም',
    playerNamePlaceholder: 'ሙሉ ስም ወይም የተጫዋች ስም',
    contactLabel: 'የተጫዋቹ ስልክ ቁጥር',
    contactPlaceholder: '+251 9XX XXX XXX',
    fullNameLabel: 'ሙሉ ስም / የተጫዋች ስም',
    phonePlaceholder: '+251 9XX XXX XXX',
    contactSummary: 'ስልክ ቁጥር',
    paymentMethod: 'የክፍያ መንገድ ይምረጡ',
    paymentLabel: 'የክፍያ መንገድ',
    mobileMoney: 'የሞባይል ገንዘብ',
    bankTransfer: 'የባንክ ሂሳብ ማስተላለፍ',
    inPersonPayment: 'በአካል ክፍያ',
    paymentDisclaimer: 'አዘጋጁ ክፍያዎን ካረጋገጠ በኋላ ቦታዎ ይጠበቃል። በዚህ መተግበሪያ ክፍያ አይሰበሰብም።',
    receiptUpload: 'የክፍያ ደረሰኝ ይጫኑ (አስፈላጊ)',
    receiptInvalid: 'ከ5 MB በታች PNG፣ JPG ወይም WebP ደረሰኝ ይምረጡ።',
    scheduleLoadError: 'የውድድር ቦታ መረጃ ለጊዜው አይገኝም።',
    proceedPayment: 'ወደ ክፍያ ይቀጥሉ እና ምዝገባን ያረጋግጡ',
    savedRegistration: 'የምዝገባ ጥያቄ ተቀምጧል።',
    followUp: 'ክፍያውን ለመጨረስ እና ቦታዎን ለማረጋገጥ የውድድሩን አዘጋጅ ያነጋግሩ።',
    profileHub: 'የተጫዋች ማዕከል',
    matchCenter: 'የጨዋታ ማዕከልዎ።',
    profileDescription: 'የተጫዋች መረጃ፣ ምዝገባ እና ወደ ፍጻሜው የሚወስድ መንገድ።',
    primePlayer: 'ፕራይም ጌሚንግ ተጫዋች',
    psnNotConnected: 'PSN መለያ አልተገናኘም',
    online: 'በመስመር ላይ',
    player: 'ተጫዋች',
    profileSettings: 'የመገለጫ ቅንብሮች',
    playerAccount: 'የተጫዋች መለያ',
    playerId: 'የተጫዋች መለያ ቁጥር',
    myTournaments: 'ውድድሮቼ',
    notificationTitle: 'ማሳወቂያዎች',
    markAllRead: 'ሁሉንም እንደተነበበ ምልክት አድርግ',
    noNotifications: 'ሁሉንም ማሳወቂያዎች አይተዋል።',
    notificationsLoading: 'ማሳወቂያዎችን በመጫን ላይ…',
    notificationsError: 'ማሳወቂያዎችን መጫን አልተቻለም።',
    notificationSignIn: 'ማሳወቂያዎን ለማየት ይግቡ።',
    accountMenu: 'የተጫዋች መለያ አማራጮች',
    deleteConfirmTitle: 'መለያዎን ይሰርዙ?',
    cancel: 'ይቅር',
    playerCode: 'የተጫዋች ኮድ',
    copyCode: 'ኮድ ቅዳ',
    copied: 'ተቀድቷል!',
    editProfile: 'መገለጫ አስተካክል',
    saveProfile: 'መገለጫ አስቀምጥ',
    deleteAccount: 'መለያ ሰርዝ',
    deleteAccountPrompt: 'የተጫዋች መለያዎን እና ምዝገባዎችዎን በቋሚነት ለመሰረዝ የይለፍ ቃልዎን ያስገቡ።',
    deleteAccountConfirm: 'መለያውን በቋሚነት ይሰርዙ?',
    profileSaved: 'መገለጫ ተዘምኗል።',
    profileUpdateError: 'መገለጫ ማዘመን አልተሳካም።',
    noBracketYet: 'አዘጋጁ የጨዋታ ድልድል ገና አላወጣም።',
    fullyBooked: 'ተሞልቷል',
    spotsLeftLabel: 'የቀሩ ቦታዎች',
    statusUpcoming: 'የሚመጣ',
    statusLive: 'በቀጥታ',
    statusCompleted: 'ተጠናቋል',
    roundOf32: 'የ32ኛው ዙር',
    roundOf16: 'የ16ኛው ዙር',
    quarterFinals: 'ሩብ ፍጻሜ',
    semiFinals: 'ግማሽ ፍጻሜ',
    final: 'ፍጻሜ',
    uploadAvatar: 'የመገለጫ ፎቶ ይጫኑ',
    weeklySchedule: 'የሳምንታዊ ውድድር መርሐግብር',
    selectWeek: 'ከሚቀጥሉት ሳምንታት ውድድር ይምረጡ',
    week: 'ሳምንት',
    tournament: 'ውድድር',
    slotsLeftOf: 'ቦታዎች ቀርተዋል / 32 ጠቅላላ',
    spotsFilled: 'ቦታዎች ተይዘዋል',
    spotsRemaining: 'ቦታዎች ቀርተዋል',
    weekCardHint: 'የውድድር ዝርዝር',
    weekDetails: 'የውድድር ዝርዝሮች',
    registerWeek: 'አሁን ይመዝገቡ፦',
    registrationWeek: 'የተመረጠው ውድድር',
    halfTimeRule: '4 ደቂቃ አጋማሾች',
    kickoffRule: 'Kick-off ሁነታ',
    formationsRule: 'ብጁ አሰላለፍ ይፈቀዳል',
    weekOpen: 'ክፍት',
    weekFull: 'ሙሉ',
    weekLive: 'በመካሄድ ላይ',
    weekCompleted: 'ተጠናቋል',
    registrationClosed: 'ምዝገባ ተዘግቷል',
    selectedWeek: 'የተመረጠው ውድድር',
    dailyHours: 'የዕለት የጨዋታ ሰዓት',
    scheduleHours: 'ከጠዋቱ 2:00 እስከ ቀን 9:00 ሰዓት',
    matchesPerDay: 'ተጫዋቾች በቦታው በአካል በቀን ከ2 እስከ 4 ጨዋታዎች ሊመደቡ ይችላሉ።',
    registeredWeek: 'የተመረጠው ሳምንት',
    generatedPsCode: 'PS ኮድ',
    signOut: 'ውጣ',
    competition: 'የእርስዎ ውድድር',
    registeredTournaments: 'የተመዘገቡባቸው ውድድሮች',
    paymentPending: 'ክፍያ በመጠባበቅ ላይ',
    noRegistrations: 'እስካሁን ምንም የውድድር ምዝገባ የለም',
    nextCompetition: 'ቀጣዩ ውድድርዎ እዚህ ይጀምራል።',
    exploreRegistration: 'ምዝገባን ይመልከቱ',
    roadToCup: 'ወደ ዋንጫው መንገድ',
    matchBracket: 'የጨዋታ ድልድል',
    knockout: '32 ተጫዋች የማስወገድ ውድድር',
    preview: 'ቅድመ እይታ',
    yourPsn: 'የPSN መለያዎ',
    opponent: 'ተቀናቃኝ',
    winnerR32: 'የ32ኛው ዙር አሸናፊ',
    matchupNotice: 'የጨዋታ ድልድሎች በውድድሩ አዘጋጅ ይገለጻሉ።',
    needHelp: 'እርዳታ ይፈልጋሉ?',
    contactSupport: 'የውድድር ግንኙነት ማዕከል',
    supportDescription: 'ስለ ምዝገባ፣ ክፍያ ወይም የጨዋታ ድልድል እገዛ ለማግኘት የውድድር አስተዳዳሪዎችን በቴሌግራም ያግኙ።',
    contactAdmin: 'አስተዳዳሪዎችን በቴሌግራም ያግኙ',
    supportUnavailable: 'የአስተዳዳሪ ግንኙነት አሁን አይገኝም። እባክዎ ቆይተው ይሞክሩ።',
    footer: '© 2026 PRIME GAMING ኢትዮጵያ። መብቱ በህግ የተጠበቀ ነው።',
    loading: 'የጨዋታ መረጃ በመጫን ላይ...',
    connecting: 'ከPlayStation Network ጋር እንደገና በመገናኘት ላይ...',
    connectionInterrupted: 'ግንኙነት ተቋርጧል',
    brandDetail: 'ፕራይም ጌሚንግ · ኢትዮጵያ',
    localServices: 'በአካባቢ እና በአካል የሚደረጉ ጨዋታዎች ብቻ',
  },
}

function Icon({ name, size = 20 }) {
  const paths = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9M9 20v-6h6v6" /></>,
    trophy: <><path d="M8 21h8m-4-4v4m-5-18h10v5a5 5 0 0 1-10 0V3Z" /><path d="M7 5H4v2a4 4 0 0 0 4 4m9-6h3v2a4 4 0 0 1-4 4" /></>,
    ticket: <><path d="M3 8a2 2 0 0 0 0 4v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2Z" /><path d="M13 5v2m0 4v2m0 4v2" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m12-13a4 4 0 0 1 0 8m4 5v-2a4 4 0 0 0-3-3.9" /><circle cx="10" cy="7" r="4" /></>,
    gamepad: <><path d="M6 11h4m-2-2v4m7-1h.01M18 10h.01" /><path d="M7 7h10a4 4 0 0 1 3.8 5.2l-1.1 3.5a2 2 0 0 1-3.3.9L14 15H10l-2.4 2.6a2 2 0 0 1-3.3-.9l-1.1-3.5A4 4 0 0 1 7 7Z" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    check: <><path d="m5 12 4 4L19 6" /></>,
    bolt: <path d="m13 2-3 8H5l6 12 3-8h5L13 2Z" />,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
    medal: <><circle cx="12" cy="8" r="5" /><path d="m8.5 12-1 9 4.5-2.5 4.5 2.5-1-9" /></>,
    support: <><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3m.1 4h.01" /></>,
    bracket: <><path d="M4 5h5v5H4zm11 9h5v5h-5zM9 7h3a3 3 0 0 1 3 3v1a3 3 0 0 0 3 3" /><path d="M4 17h5v2H4z" /></>,
    login: <><path d="M10 17l5-5-5-5m5 5H3" /><path d="M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6" /></>,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    edit: <><path d="m15 5 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15z" /><path d="M13 6 18 11" /></>,
    logout: <><path d="M10 17l5-5-5-5m5 5H3" /><path d="M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6" /></>,
    trash: <><path d="M3 6h18m-2 0-1 14H6L5 6m4 0V4h6v2m-5 4v6m4-6v6" /></>,
    read: <><path d="m5 12 4 4L19 6" /></>,
  }

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  )
}

function SoccerBallArt() {
  return <img className="soccer-ball-art" src="/ball.png" alt="" />
}

function Header({
  lang, onLanguageChange, player, avatar, unreadCount, notifications, notificationsLoading,
  notificationsError, onRefreshNotifications, onMarkNotificationRead, onMarkAllNotificationsRead,
  onProfileAction, onLogout, onHome, onLogin,
}) {
  const text = translations[lang]
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [menuError, setMenuError] = useState('')
  const profileMenuRef = useRef(null)
  const notificationsRef = useRef(null)
  const initials = player?.displayName?.trim()?.slice(0, 1)?.toUpperCase() || 'P'

  useEffect(() => {
    function handleOutsideClick(event) {
      if (!profileMenuRef.current?.contains(event.target)) setProfileMenuOpen(false)
      if (!notificationsRef.current?.contains(event.target)) setNotificationsOpen(false)
    }
    function handleEscape(event) {
      if (event.key === 'Escape') {
        setProfileMenuOpen(false)
        setNotificationsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    window.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [])

  async function toggleNotifications() {
    const opening = !notificationsOpen
    setNotificationsOpen(opening)
    setProfileMenuOpen(false)
    setMenuError('')
    if (opening) await onRefreshNotifications()
  }

  async function signOut() {
    setMenuError('')
    try {
      await onLogout()
      setProfileMenuOpen(false)
    } catch (error) {
      setMenuError(error.message)
    }
  }

  async function switchPlayer() {
    setMenuError('')
    try {
      await onLogout()
      setProfileMenuOpen(false)
      onLogin()
    } catch (error) {
      setMenuError(error.message)
    }
  }

  return (
    <header className="topbar">
      <button className="brand" type="button" onClick={onHome} aria-label={lang === 'ET' ? 'ፕራይም ጌሚንግ መነሻ' : 'Prime Gaming home'}>
        <span className="header-logo-window"><img src="/headlg.png" alt="" /></span>
      </button>
      <div className="header-actions">
        <div className="language-switch" role="group" aria-label={lang === 'ET' ? 'ቋንቋ' : 'Language'}>
          {['ET', 'EN'].map((language) => (
            <button
              type="button"
              key={language}
              className={lang === language ? 'language-option language-option--active' : 'language-option'}
              onClick={() => onLanguageChange(language)}
              aria-pressed={lang === language}
            >
              {language === 'ET' ? 'አማ' : 'EN'}
            </button>
          ))}
        </div>
        {player ? (
          <>
            <div className="notification-anchor" ref={notificationsRef}>
              <button className={`notification-trigger${notificationsOpen ? ' notification-trigger--active' : ''}`} type="button" onClick={toggleNotifications} aria-label={`${text.notificationTitle}${unreadCount ? `, ${unreadCount} unread` : ''}`} aria-expanded={notificationsOpen} aria-haspopup="dialog">
                <Icon name="bell" size={18} />
                {unreadCount > 0 && <span className="notification-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}
              </button>
              {notificationsOpen && <section className="notification-panel" role="dialog" aria-label={text.notificationTitle}>
                <header className="notification-panel-header">
                  <span><small>{text.playerAccount}</small><strong>{text.notificationTitle}</strong></span>
                  {unreadCount > 0 && <button type="button" onClick={onMarkAllNotificationsRead}>{text.markAllRead}</button>}
                </header>
                {notificationsError
                  ? <p className="notification-state notification-state--error" role="alert">{notificationsError || text.notificationsError}</p>
                  : notificationsLoading
                    ? <p className="notification-state">{text.notificationsLoading}</p>
                    : notifications.length
                      ? <div className="notification-list">{notifications.map((notification) => (
                        <button className={`notification-item${notification.isRead ? '' : ' notification-item--unread'}`} type="button" key={notification.id} onClick={() => !notification.isRead && onMarkNotificationRead(notification.id)}>
                          <span className="notification-item-icon"><Icon name={notification.type === 'registration' ? 'trophy' : 'bell'} size={16} /></span>
                          <span className="notification-item-copy"><strong>{notification.title}</strong><span>{notification.message}</span><small>{new Date(notification.createdAt).toLocaleString(lang === 'ET' ? 'am-ET' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })}</small></span>
                          {!notification.isRead && <i className="notification-unread-dot" />}
                        </button>
                      ))}</div>
                      : <p className="notification-state">{text.noNotifications}</p>}
                {menuError && <p className="notification-state notification-state--error" role="alert">{menuError}</p>}
              </section>}
            </div>
            <div className="profile-menu-anchor" ref={profileMenuRef}>
              <button className="header-player" type="button" onClick={() => {
                setProfileMenuOpen((open) => !open)
                setNotificationsOpen(false)
                setMenuError('')
              }} aria-label={`${text.accountMenu}: ${player.displayName}`} aria-expanded={profileMenuOpen} aria-haspopup="menu">
                <span className="header-avatar">{avatar ? <img src={avatar} alt="" /> : initials}</span>
                <span className="header-player-copy">
                  <strong>{player.displayName}</strong>
                  <small><i /> {player.playerCode || text.primePlayer}</small>
                </span>
                <Icon name="chevron" size={13} />
              </button>
              {profileMenuOpen && <section className="profile-dropdown" role="menu" aria-label={text.accountMenu}>
                <div className="profile-dropdown-identity">
                  <span className="profile-dropdown-avatar">{avatar ? <img src={avatar} alt="" /> : initials}</span>
                  <span><strong>{player.displayName}</strong><small>{player.telegramUsername ? `@${player.telegramUsername}` : player.contact}</small></span>
                </div>
                <div className="profile-dropdown-code"><small>{text.playerId}</small><strong>{player.playerCode || player.id}</strong></div>
                <button type="button" role="menuitem" onClick={() => {
                  setProfileMenuOpen(false)
                  onProfileAction('edit')
                }}><Icon name="edit" size={16} />{text.editProfile}</button>
                <button type="button" role="menuitem" onClick={() => {
                  setProfileMenuOpen(false)
                  onProfileAction('tournaments')
                }}><Icon name="trophy" size={16} />{text.myTournaments}</button>
                <button className="profile-dropdown-danger" type="button" role="menuitem" onClick={() => {
                  setProfileMenuOpen(false)
                  onProfileAction('delete')
                }}><Icon name="trash" size={16} />{text.deleteAccount}</button>
                <button className="profile-dropdown-signout" type="button" role="menuitem" onClick={signOut}><Icon name="logout" size={16} />{text.signOut}</button>
                <button type="button" role="menuitem" onClick={switchPlayer}><Icon name="user" size={16} />{lang === 'ET' ? 'ሌላ ተጫዋች ቀይር' : 'Switch player account'}</button>
                {menuError && <p className="notification-state notification-state--error" role="alert">{menuError}</p>}
              </section>}
            </div>
          </>
        ) : (
          <button className="header-login" type="button" onClick={onLogin}>
            <Icon name="login" size={15} /><span>{text.login}</span>
          </button>
        )}
      </div>
    </header>
  )
}

function SectionHeading({ kicker, title, action }) {
  return (
    <div className="section-heading">
      <div><span className="eyebrow">{kicker}</span><h2>{title}</h2></div>
      {action}
    </div>
  )
}

function HomeTab({ onNavigate, lang, schedule, scheduleError, activeRegistration }) {
  const text = translations[lang]
  const featuredTournament = schedule.find((item) => item.id === activeRegistration?.weekId) || schedule[0]
  const featuredCapacity = featuredTournament?.capacity || tournament.slots
  const featuredRemaining = featuredTournament?.remaining ?? tournament.remaining
  const filledPercent = ((featuredCapacity - featuredRemaining) / featuredCapacity) * 100
  const features = [
    { title: text.leagues, detail: text.leaguesDetail, icon: 'gamepad', className: 'feature-blue' },
    { title: text.tournaments, detail: text.tournamentsDetail, icon: 'trophy', className: 'feature-purple' },
    { title: text.friendly, detail: text.friendlyDetail, icon: 'users', className: 'feature-green' },
    { title: text.official, detail: text.officialDetail, icon: 'shield', className: 'feature-cyan' },
  ]

  return (
    <section className="tab-panel home-tab" aria-labelledby="home-title">
      <div className="home-hero">
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-texture" aria-hidden="true">
          <span>FC 27</span><span>FC 26</span><span>HYPERMOTION</span><span>EASPORTS FC</span><span>PLAYSTATION ONLY</span>
        </div>
        <div className="hero-copy">
          <span className="hero-kicker"><i /> {text.heroKicker}</span>
          <h1 id="home-title" className="home-brand-lockup">
            <img src="/logo.png" alt="PRIME GAMING" />
            <span>{text.psnOnly}</span>
          </h1>
          <p>{text.heroSubhead}</p>
          <button className="primary-button hero-button" type="button" onClick={() => onNavigate('tournament')}>
            {text.exploreCup} <Icon name="arrow" size={17} />
          </button>
        </div>
        <img className="controller-art" src="/joy.png" alt="" />
        <SoccerBallArt />
        <span className="hero-sponsor-badge"><b>FC 27</b><i /> PRO LEAGUE</span>
        <div className="hero-platform-tag"><span>PS4</span><i /><span>PS5</span></div>
      </div>

      <button className="ticker-card" type="button" onClick={() => onNavigate('tournament')}>
        <span className="ticker-badge"><Icon name="trophy" size={18} /></span>
        <span className="ticker-copy"><small>{text.tickerOpen}</small><strong>{featuredTournament?.name || text.cup} <span>🏆</span></strong></span>
        <span className="ticker-prize"><small>{text.prizePoolLabel}</small><strong>{tournament.prizePool}</strong></span>
        <span className="ticker-arrow"><Icon name="chevron" size={18} /></span>
      </button>

      <div className="section-block home-features">
        <SectionHeading kicker={text.servicesSubhead} title={text.chooseZone} />
        <div className="feature-grid">
          {features.map((feature) => (
            <article className={`feature-card ${feature.className}`} key={feature.title}>
              <span className="feature-icon"><Icon name={feature.icon} size={19} /></span>
              {feature.icon === 'trophy' && <span className="feature-sponsor">FC 27<br />PRO LEAGUE</span>}
              <strong>{feature.title}</strong>
              <small>{feature.detail}</small>
              <span className="zone-service-label">{text.localServices}</span>
              <span className="zone-official">{text.officialDetail}</span>
            </article>
          ))}
        </div>
      </div>

      <section className="slots-card" aria-label={`${featuredRemaining} of ${featuredCapacity} tournament slots remaining`}>
        <div className="slots-heading">
          <span className="slots-icon"><Icon name="users" size={18} /></span>
          <span><small>{text.capacity}</small><strong>{featuredRemaining} <i>/ {featuredCapacity}</i> {text.slotsRemaining}</strong></span>
          <span className="slots-open"><i /> {featuredTournament?.status === 'full' ? text.fullyBooked : text.open}</span>
        </div>
        <div
          className="slots-track"
          role="progressbar"
          aria-label={text.capacity}
          aria-valuemin="0"
          aria-valuemax={featuredCapacity}
          aria-valuenow={featuredCapacity - featuredRemaining}
        >
          <span style={{ width: `${filledPercent}%` }} />
        </div>
        <div className="slots-foot"><span>{featuredCapacity - featuredRemaining} / {featuredCapacity} {text.spotsFilled}</span>{!activeRegistration && <button type="button" onClick={() => onNavigate('register')}>{text.claimSpot} <Icon name="arrow" size={14} /></button>}</div>
      </section>
      {scheduleError && <p className="schedule-error" role="status">{scheduleError}</p>}
    </section>
  )
}

function TournamentTab({ onRegister, lang, schedule, scheduleError, selectedWeek, activeRegistration }) {
  const text = translations[lang]
  const [showRules, setShowRules] = useState(false)
  const [manualDetailsWeek, setManualDetailsWeek] = useState(null)
  const [detailsHidden, setDetailsHidden] = useState(false)
  const [fixtureData, setFixtureData] = useState(null)
  const [fixturesLoading, setFixturesLoading] = useState(false)
  const [fixturesError, setFixturesError] = useState('')
  const visibleSchedule = activeRegistration
    ? schedule.filter((week) => week.id === activeRegistration.weekId)
    : schedule
  const activeWeekId = activeRegistration?.weekId
  const detailsWeek = activeRegistration
    ? detailsHidden ? null : schedule.find((week) => week.id === activeWeekId) || null
    : manualDetailsWeek
  const detailsLoading = fixturesLoading || Boolean(
    detailsWeek && fixtureData?.tournament?.weekId !== detailsWeek.id && !fixturesError,
  )
  const scopedTournamentId = activeRegistration?.weekId ?? selectedWeek
  const featuredTournament = visibleSchedule.find((week) => week.id === scopedTournamentId) || visibleSchedule[0]
  const entryClosed = !featuredTournament || featuredTournament.status !== 'open' || featuredTournament.remaining < 1
  const featuredStatus = featuredTournament?.status === 'live'
    ? text.weekLive
    : featuredTournament?.status === 'completed'
      ? text.weekCompleted
      : featuredTournament?.status === 'full' || (featuredTournament && featuredTournament.remaining < 1)
        ? text.fullyBooked
        : text.weekOpen
  const prizePool = Number(featuredTournament?.prizePool ?? 20000)
  const prizeAmounts = [
    Math.round(prizePool * 0.5),
    Math.round(prizePool * 0.25),
    Math.round(prizePool * 0.15),
    0,
  ]
  prizeAmounts[3] = prizePool - prizeAmounts.slice(0, 3).reduce((total, amount) => total + amount, 0)

  useEffect(() => {
    if (!detailsWeek) return undefined
    let active = true
    playerRequest(`/tournaments/${detailsWeek.id}/fixtures`)
      .then((data) => {
        if (active) setFixtureData(data)
      })
      .catch((error) => {
        if (active) setFixturesError(error.message)
      })
      .finally(() => {
        if (active) setFixturesLoading(false)
      })
    return () => { active = false }
  }, [detailsWeek])

  function openTournamentDetails(week) {
    if (detailsWeek?.id === week.id) {
      if (activeRegistration) setDetailsHidden(true)
      else setManualDetailsWeek(null)
      return
    }
    setDetailsHidden(false)
    setFixtureData(null)
    setFixturesError('')
    setFixturesLoading(true)
    setManualDetailsWeek(week)
  }

  return (
    <section className="tab-panel detail-tab" aria-labelledby="tournament-title">
      <header className="tournament-page-heading">
        <span className="eyebrow">{text.nationalSeries}</span>
        <h1 id="tournament-title">{text.cup}</h1>
        <p>{text.tournamentSubtitle}</p>
      </header>

      <div className="tournament-price-ribbon" aria-label={lang === 'ET' ? 'የመግቢያ ክፍያና የሽልማት ገንዘብ' : 'Tournament entry and prize pool'}>
        <div><span>{text.entryFeeLabel}</span><strong>{Number(featuredTournament?.entryFee ?? 1500).toLocaleString()} <small>ETB</small></strong></div>
        <i aria-hidden="true" />
        <div><span>{text.championshipPrizePool}</span><strong>{Number(featuredTournament?.prizePool ?? 20000).toLocaleString()} <small>ETB</small></strong></div>
      </div>

      <section className="section-block">
        <SectionHeading kicker={text.competeForTop} title={text.prizeBreakdown} action={<span className="pool-chip">{Number(featuredTournament?.prizePool ?? 20000).toLocaleString()} ETB {text.totalPrizePool}</span>} />
        <div className="prize-grid">
          {prizes.map((prize, index) => (
            <article className={`prize-card prize-${prize.className}`} key={prize.place}>
              <div className="prize-card-top">
                <span className="prize-rank"><span className="prize-medal" aria-hidden="true">{prize.medal}</span><span>#{index + 1}</span></span>
                <span className={`prize-status${index === 0 ? ' champion-badge' : ''}`}>{text[['champion', 'runnerUp', 'thirdAward', 'fourthAward'][index]]}</span>
              </div>
              <strong className="prize-amount"><span>{prizeAmounts[index].toLocaleString()}</span><small>ETB</small></strong>
              <span className="prize-place">{text[`${['first', 'second', 'third', 'fourth'][index]}Place`]}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="section-block">
        <SectionHeading kicker={text.selectWeek} title={text.availableTournaments} />
        <TournamentScheduleCards
          schedule={visibleSchedule}
          text={text}
          lang={lang}
          selectedWeek={selectedWeek}
          detailsWeek={detailsWeek}
          fixtureData={fixtureData}
          fixturesLoading={detailsLoading}
          fixturesError={fixturesError}
          onRegister={onRegister}
          onDetails={openTournamentDetails}
        />
        {scheduleError && <p className="schedule-error" role="status">{scheduleError}</p>}
      </section>

      <button className="rules-accordion rules-trigger" type="button" onClick={() => setShowRules(true)}>
        <span className="rules-summary-icon"><Icon name="shield" size={18} /></span>
        <span className="rules-trigger-copy"><small>{text.info}</small><strong>{text.rules}</strong></span>
        <span className="rules-more-label">{text.seeRules}</span>
        <Icon name="chevron" size={18} />
      </button>

      <div className="detail-slots">
        <span><Icon name="users" size={17} /> {featuredTournament?.remaining ?? tournament.remaining} / {featuredTournament?.capacity || tournament.slots} {text.slotsLeft}</span>
        <span className="detail-live"><i /> {featuredStatus}</span>
      </div>
      {!activeRegistration && <button className="primary-button full-button" type="button" disabled={entryClosed} onClick={() => onRegister(featuredTournament.id)}>
        {entryClosed ? text.registrationClosed : text.register} {entryClosed ? '' : `${Number(featuredTournament.entryFee ?? 1500).toLocaleString()} ETB`} {!entryClosed && <Icon name="arrow" size={17} />}
      </button>}
      <LeaderboardPanel />
      {showRules && <RulesModal text={text} onClose={() => setShowRules(false)} />}
    </section>
  )
}

function RulesModal({ text, onClose }) {
  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    createPortal(<div className="rules-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="rules-modal" role="dialog" aria-modal="true" aria-labelledby="rules-modal-title">
        <button className="rules-modal-close" type="button" onClick={onClose} aria-label={text.close}><Icon name="close" size={20} /></button>
        <span className="rules-modal-icon"><Icon name="shield" size={23} /></span>
        <span className="eyebrow">{text.info}</span>
        <h2 id="rules-modal-title">{text.rulesTitle}</h2>
        <div className="rules-modal-list">
          <div><span>{text.halfLength}</span><strong>4 {text.minutes}</strong></div>
          <div><span>{text.mode}</span><strong>{text.kickoff}</strong></div>
          <div><span>{text.tactics}</span><strong>{text.allowed}</strong></div>
          <div><span>{text.format}</span><strong>{text.knockoutFormat}</strong></div>
        </div>
        <div className="anti-gambling-notice">
          <strong>{text.strictPolicy}</strong>
          <p>{text.antiGambling}</p>
        </div>
        <button className="primary-button full-button" type="button" onClick={onClose}>{text.close}</button>
      </section>
    </div>, document.body)
  )
}

function RegistrationTab({ form, onChange, onSubmit, submitted, submitting, submitError, copyAccountError, receiptName, onReceiptChange, lang, selectedWeek, onWeekChange, schedule, scheduleError, activeRegistration, addingToActive, onAddToActive, onCancelAddToActive, player, participants, onAddParticipant, onParticipantChange, onRemoveParticipant, paymentAccounts, onCopyAccount, copiedAccount, totalEntryFee }) {
  const text = translations[lang]
  const selectedSchedule = schedule.find((week) => week.id === selectedWeek)
    || { name: text.tournament, dateRange: '', entryFee: 1500, capacity: 32, remaining: 32, status: 'open' }

  return (
    <section className="tab-panel register-tab" aria-labelledby="register-title">
      <div className="page-intro">
        <span className="eyebrow">{text.introKicker}</span>
        <h1 id="register-title">{text.introTitle}</h1>
        <p>{text.introDescription}</p>
      </div>

      <div className="registration-banner">
        <span className="banner-icon"><Icon name="ticket" size={20} /></span>
        <span><small>{text.entryBanner}</small><strong>{Number(selectedSchedule.entryFee ?? 1500).toLocaleString()} ETB</strong></span>
        <span className="banner-platform">PS4 / PS5</span>
      </div>
      <p className="registration-week-selection"><Icon name="calendar" size={15} /><span>{text.registrationWeek}: <strong>{selectedSchedule.name || text[selectedSchedule.nameKey]}</strong> · {selectedSchedule.dateRange}</span></p>
      {scheduleError && <p className="registration-error" role="alert">{scheduleError}</p>}

      {activeRegistration && !addingToActive ? <div className="registration-active-notice" role="status">
        <strong>{lang === 'ET' ? 'በአንድ ጊዜ በአንድ ውድድር ብቻ ሊሳተፉ ይችላሉ።' : 'Your account can be active in one tournament at a time.'}</strong>
        <span>{activeRegistration.tournament?.name || `Prime Ethiopia Cup ${activeRegistration.weekId + 1}`} · {lang === 'ET' ? 'ሌላ ተጫዋች በዚህ ውድድር ያክሉ፤ ወይም ከመጨረሻው በኋላ ሌላ ውድድር ይቀላቀሉ።' : 'Add another player to this tournament, or join a different one after it concludes.'}</span>
        {player && <button
          className="group-add-player"
          type="button"
          onClick={onAddToActive}
        >
          {lang === 'ET' ? 'ሌላ ተጫዋች ይመዝግቡ' : 'Sign other players'}
        </button>}
      </div> :
      <form className="registration-form" onSubmit={onSubmit}>
        {addingToActive && <div className="registration-active-notice" role="status">
          <strong>{lang === 'ET' ? 'ሌላ ተጫዋች በማንኛውም ክፍት ውድድር ይመዝግቡ' : 'Register another player in any open tournament'}</strong>
          <span>{lang === 'ET' ? 'የውድድር ዝርዝር ይምረጡ። ክፍያው ለአስተዳዳሪ ማረጋገጫ ይላካል።' : 'Choose a tournament below. Payment will be sent to admin for approval.'}</span>
          <button className="group-remove-player" type="button" onClick={onCancelAddToActive}>{lang === 'ET' ? 'ተመለስ' : 'Cancel'}</button>
        </div>}
        {addingToActive && <>
          <label className="field-label" htmlFor="other-player-tournament">{lang === 'ET' ? 'ውድድር ይምረጡ' : 'Choose a tournament'}</label>
          <select
            id="other-player-tournament"
            value={selectedSchedule.id}
            onChange={(event) => onWeekChange(Number(event.target.value))}
            required
          >
            {schedule.map((week) => (
              <option key={week.id} value={week.id} disabled={!['open', 'full'].includes(week.status) || week.remaining < 1}>
                {week.name} · {week.remaining} {lang === 'ET' ? 'ቦታ ቀርቷል' : 'spots left'}
              </option>
            ))}
          </select>
          <div className="group-participant">
            <strong>{selectedSchedule.name} · {Number(selectedSchedule.entryFee ?? 1500).toLocaleString()} ETB</strong>
            <span>{selectedSchedule.remaining > 0 && ['open', 'full'].includes(selectedSchedule.status)
              ? (lang === 'ET' ? `${selectedSchedule.remaining} ቦታ ይገኛል` : `${selectedSchedule.remaining} spots available`)
              : (lang === 'ET' ? 'በዚህ ውድድር ቦታ የለም' : 'No spots available in this tournament')}</span>
          </div>
        </>}
        {player && !addingToActive && <button className="group-add-player" type="button" onClick={onAddToActive}>
          {lang === 'ET' ? 'ሌላ ተጫዋች ይመዝግቡ' : 'Sign other players'}
        </button>}
        {!addingToActive && <>
          <div className="form-section-title"><span>01</span><strong>{text.playerDetails}</strong></div>
        <label className="field-label" htmlFor="player-name">{text.fullNameLabel}</label>
        <input id="player-name" name="playerName" value={form.playerName} onChange={onChange} placeholder={text.playerNamePlaceholder} autoComplete="name" maxLength={60} required />

        <label className="field-label" htmlFor="player-contact">{text.contactLabel}</label>
        <input id="player-contact" name="contact" value={form.contact} onChange={onChange} placeholder={text.contactPlaceholder} autoComplete="off" maxLength={64} required />

        <label className="field-label" htmlFor="player-telegram-username">{text.telegramUsername}</label>
        <input id="player-telegram-username" name="telegramUsername" value={form.telegramUsername || ''} onChange={onChange} maxLength={33} placeholder="@username" autoComplete="off" pattern="@?[A-Za-z0-9_]{5,32}" required />
        <label className="field-label" htmlFor="player-session">{lang === 'ET' ? 'የጨዋታ ሰዓት ምርጫ' : 'Preferred session'}</label>
        <select id="player-session" name="sessionPreference" value={form.sessionPreference || 'any'} onChange={onChange}>
          <option value="any">{lang === 'ET' ? 'ማንኛውም ሰዓት' : 'Any session'}</option>
          <option value="morning">{lang === 'ET' ? 'ጠዋት' : 'Morning'}</option>
          <option value="afternoon">{lang === 'ET' ? 'ከሰዓት በኋላ' : 'Afternoon'}</option>
          <option value="evening">{lang === 'ET' ? 'ማታ' : 'Evening'}</option>
        </select>
        </>}
        {participants.map((participant, index) => (
          <fieldset className="group-participant" key={participant.id}>
            <legend>{lang === 'ET' ? `ተጨማሪ ተጫዋች ${index + 1}` : `Additional player ${index + 1}`}</legend>
            <label className="field-label" htmlFor={`group-name-${participant.id}`}>{text.fullNameLabel}</label>
            <input id={`group-name-${participant.id}`} value={participant.playerName} maxLength={60} autoComplete="name" onChange={(event) => onParticipantChange(participant.id, 'playerName', event.target.value)} required />
            <label className="field-label" htmlFor={`group-contact-${participant.id}`}>{lang === 'ET' ? 'የተጫዋቹ ስልክ ቁጥር' : 'Player phone number'}</label>
            <input id={`group-contact-${participant.id}`} type="tel" value={participant.contact} maxLength={64} placeholder="+251..." autoComplete="tel" onChange={(event) => onParticipantChange(participant.id, 'contact', event.target.value)} required />
            <label className="field-label" htmlFor={`group-telegram-${participant.id}`}>{text.telegramUsername}</label>
            <input id={`group-telegram-${participant.id}`} value={participant.telegramUsername} maxLength={33} placeholder="@username" autoComplete="off" pattern="@?[A-Za-z0-9_]{5,32}" onChange={(event) => onParticipantChange(participant.id, 'telegramUsername', event.target.value)} required />
            <label className="field-label" htmlFor={`group-session-${participant.id}`}>{lang === 'ET' ? 'የጨዋታ ሰዓት' : 'Preferred session'}</label>
            <select id={`group-session-${participant.id}`} value={participant.sessionPreference} onChange={(event) => onParticipantChange(participant.id, 'sessionPreference', event.target.value)}>
              <option value="any">Any session</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option><option value="evening">Evening</option>
            </select>
            <button type="button" className="group-remove-player" onClick={() => onRemoveParticipant(participant.id)}>{lang === 'ET' ? 'አስወግድ' : 'Remove player'}</button>
          </fieldset>
        ))}
        {addingToActive && <button type="button" className="group-add-player" onClick={onAddParticipant}>
          ＋ {lang === 'ET' ? 'ተጫዋች ጨምር' : 'Add player'}
        </button>}
        {!addingToActive && <button type="button" className="group-add-player" onClick={onAddParticipant}>＋ {player
          ? (lang === 'ET' ? 'ሌላ ተጫዋች ጨምር' : 'Add Another Player')
          : (lang === 'ET' ? 'ሌላ ተጫዋች ለመጨመር ይግቡ' : 'Sign in to add another player')}</button>}

        {['cbe', 'telebirr'].includes(form.payment) && (
          <div className="payment-account-list" aria-label="Payment accounts">
            {paymentAccounts.filter((account) => account.type === form.payment).map((account) => (
              <article className="payment-account-card" key={account.type}>
                <div><small>{account.type === 'cbe' ? 'CBE Bank' : 'Telebirr'}</small><strong>{account.name || (account.type === 'cbe' ? 'Commercial Bank of Ethiopia' : 'Prime Ethiopia Cup')}</strong><b>{account.number || (lang === 'ET' ? 'የአካውንት ዝርዝር በቅርቡ ይገኛል' : 'Account details will be announced soon')}</b></div>
                <button type="button" onClick={() => onCopyAccount(account)} disabled={!account.number}>{copiedAccount === account.type ? (lang === 'ET' ? 'ተቀድቷል!' : 'Copied!') : (lang === 'ET' ? 'ቅዳ' : 'Copy')}</button>
              </article>
            ))}
          </div>
        )}

        <label className="receipt-upload" htmlFor="payment-receipt">
          <Icon name="ticket" size={17} />
          <span>{receiptName || text.receiptUpload}</span>
          <input key={receiptName || 'empty'} id="payment-receipt" type="file" accept="image/png,image/jpeg,image/webp" onChange={onReceiptChange} required />
        </label>

        <div className="form-section-title payment-title"><span>{addingToActive ? '01' : '02'}</span><strong>{text.paymentMethod}</strong></div>
        <div className="payment-list" role="radiogroup" aria-label={text.paymentLabel}>
          {payments.map((payment) => (
            <label className={`payment-option${form.payment === payment.id ? ' payment-option--selected' : ''}`} key={payment.id}>
              <input type="radio" name="payment" value={payment.id} checked={form.payment === payment.id} onChange={onChange} required />
              <span className={`payment-mark payment-mark--${payment.id}`}>
                {payment.image && <img src={payment.image} alt="" onError={(event) => event.currentTarget.remove()} />}
                <span>{payment.id === 'cash' ? 'ETB' : payment.shortName || payment.mark}</span>
              </span>
              <span className="payment-name"><strong>{payment.id === 'cash' ? text.cash : payment.name}</strong><small>{payment.id === 'telebirr' ? text.mobileMoney : payment.id === 'cash' ? text.inPersonPayment : text.bankTransfer}</small></span>
              <span className="payment-radio"><i /></span>
            </label>
          ))}
        </div>

        <div className="payment-disclaimer"><Icon name="shield" size={16} /><span>{text.paymentDisclaimer}</span></div>
        <p className="group-total">{lang === 'ET' ? 'አጠቃላይ ክፍያ' : 'Group total'} <strong>{totalEntryFee.toLocaleString()} ETB</strong> <span>· {addingToActive ? participants.length : participants.length + 1} {(addingToActive ? participants.length : participants.length + 1) === 1 ? 'player' : 'players'}</span></p>
        <button className="primary-button full-button payment-submit" type="submit" disabled={submitting || !['open', 'full'].includes(selectedSchedule.status) || (addingToActive && participants.length === 0) || selectedSchedule.remaining < (addingToActive ? participants.length : participants.length + 1)}>
          {submitting ? (lang === 'ET' ? 'በማስቀመጥ ላይ...' : 'Saving registration…') : !['open', 'full'].includes(selectedSchedule.status) || selectedSchedule.remaining < 1 ? text.registrationClosed : text.proceedPayment} {!submitting && <Icon name="arrow" size={17} />}
        </button>
        {copyAccountError && <p className="registration-error" role="alert">{copyAccountError}</p>}
        {submitError && <p className="registration-error" role="alert">{submitError}</p>}
        {submitted && (
          <p className="form-success" role="status"><Icon name="check" size={18} /><span><strong>{text.savedRegistration}</strong> {text.followUp}</span></p>
        )}
      </form>}
    </section>
  )
}

function localizedRoundName(match, text, lang) {
  if (lang !== 'ET') return match.roundName || `${text.round} ${match.round + 1}`
  const roundName = (match.roundName || '').toLowerCase()
  if (roundName.includes('semi')) return text.semiFinals
  if (roundName.includes('quarter')) return text.quarterFinals
  if (roundName.includes('final') || roundName.endsWith('of 2')) return text.final
  if (roundName.endsWith('of 32')) return text.roundOf32
  if (roundName.endsWith('of 16')) return text.roundOf16
  return `${text.round} ${match.round + 1}`
}

function localizedTournamentDate(dateRange, lang) {
  if (lang !== 'ET') return dateRange
  const months = {
    Jan: 'ጃንዋሪ',
    Feb: 'ፌብሩዋሪ',
    Mar: 'ማርች',
    Apr: 'ኤፕሪል',
    May: 'ሜይ',
    Jun: 'ጁን',
    Jul: 'ጁላይ',
    Aug: 'ኦገስት',
    Sep: 'ሴፕቴምበር',
    Oct: 'ኦክቶበር',
    Nov: 'ኖቬምበር',
    Dec: 'ዲሴምበር',
  }
  return dateRange.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (month) => months[month])
}

function TournamentScheduleCards({
  schedule, text, lang = 'EN', selectedWeek, detailsWeek, fixtureData, fixturesLoading, fixturesError,
  onRegister, onDetails,
}) {
  return (
    <div className="weekly-options tournament-card-grid">
      {schedule.map((week) => {
        const closed = week.status !== 'open' || week.remaining < 1
        const statusClass = week.status === 'full' || week.remaining < 1 ? 'full' : week.status
        const filledPercent = week.capacity ? Math.min(100, week.filled / week.capacity * 100) : 0
        const urgentSpots = filledPercent >= 80
        const statusLabel = week.status === 'live'
          ? text.weekLive
          : week.status === 'completed'
            ? text.weekCompleted
            : week.remaining < 1 || week.status === 'full'
              ? text.fullyBooked
              : text.weekOpen
        const displayName = lang === 'ET' ? `${text.cup} ${week.id + 1}` : week.name
        return (
          <article className={`weekly-option${selectedWeek === week.id ? ' weekly-option--selected' : ''}`} key={week.id}>
            <div className="tournament-card-heading">
              <div className="tournament-card-title">
                <small>{text.cupSeries}</small>
                <h3>{displayName}</h3>
                <span>{localizedTournamentDate(week.dateRange, lang)} · EA SPORTS FC 26</span>
              </div>
              <span className={`weekly-status weekly-status--${statusClass}`}>{statusLabel}</span>
              <img className="tournament-card-ball" src="/ball.png" alt="" />
            </div>
            <div className="tournament-card-value-row">
              <div><span>{text.cardEntryFee}</span><strong>{Number(week.entryFee ?? 1500).toLocaleString()} <small>ETB</small></strong></div>
              <div><span>{text.cardPrizePool}</span><strong>{Number(week.prizePool ?? 20000).toLocaleString()} <small>ETB</small></strong></div>
            </div>
            <span className="tournament-card-format">EA SPORTS FC 26 <i /> PS4 / PS5 <i /> {text.cardFormat}</span>
            <div className="tournament-card-capacity">
              <div className="tournament-card-spots">
                <span><strong>{Math.max(0, week.remaining)}</strong><span>{text.spotsLeftShort}</span></span>
                <span>{week.filled}<i>/</i>{week.capacity}<small> {text.filledShort}</small></span>
              </div>
              <div
                className={`tournament-slot-meter${urgentSpots ? ' tournament-slot-meter--urgent' : ''}`}
                role="progressbar"
                aria-label={lang === 'ET' ? `${displayName} የተያዙ ቦታዎች` : `${displayName} spots filled`}
                aria-valuemin="0"
                aria-valuemax={week.capacity}
                aria-valuenow={week.filled}
              ><i style={{ width: `${filledPercent}%` }} /></div>
            </div>
            <div className="tournament-card-actions">
              {onDetails && (
                <button
                  className="tournament-card-details"
                  type="button"
                  aria-expanded={detailsWeek?.id === week.id}
                  aria-controls={`tournament-details-${week.id}`}
                  onClick={() => onDetails(week)}
                >{detailsWeek?.id === week.id ? text.hideDetails : text.detailsFixtures}</button>
              )}
              <button className="tournament-card-register" type="button" disabled={closed} onClick={() => onRegister(week.id)}>{closed ? text.registrationClosed : text.registerNow}</button>
            </div>
            {detailsWeek?.id === week.id && (
              <div className="tournament-inline-details" id={`tournament-details-${week.id}`}>
                <div className="tournament-details-facts">
                  <span><strong>{text.gameLabel}</strong> EA SPORTS FC 26</span>
                  <span><strong>{text.platformsLabel}</strong> PS4 / PS5</span>
                  <span><strong>{text.formatLabel}</strong> {text.cardFormat}</span>
                  <span><strong>{text.registrationLabel}</strong> {statusLabel}</span>
                  <span><strong>{text.spotsLabel}</strong> {lang === 'ET'
                    ? `ከጠቅላላው ${week.capacity} ቦታዎች፣ ${Math.max(0, week.remaining)} ክፍት ናቸው።`
                    : `${Math.max(0, week.remaining)} available of ${week.capacity}`}</span>
                </div>
                <h3>{text.fixturesMatchups}</h3>
                {fixturesLoading && <p>{text.loadingFixtures}</p>}
                {fixturesError && <p className="schedule-error" role="alert">{fixturesError}</p>}
                {!fixturesLoading && !fixturesError && fixtureData?.matches?.length > 0
                  ? fixtureData.matches.filter((match) => match.status !== 'bye').map((match) => (
                    <article className="tournament-fixture-row" key={match.matchId}>
                      <span>{localizedRoundName(match, text, lang)} · {lang === 'ET' ? 'ጨዋታ' : 'Match'} {match.matchNumber}</span>
                      <strong>{match.player1?.playerName || text.unknownPlayer} <i>{text.vs}</i> {match.player2?.playerName || text.unknownPlayer}</strong>
                      {match.scheduledAt && <small>{new Date(match.scheduledAt).toLocaleString(lang === 'ET' ? 'am-ET' : 'en-US')}</small>}
                      {match.location && <small>{match.location}</small>}
                      {match.status === 'finished' && <small>{text.finalScore} · {match.score1} : {match.score2}</small>}
                    </article>
                  ))
                  : !fixturesLoading && !fixturesError && <p>{text.drawNotPublished}</p>}
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}

function BracketPlayer({ player }) {
  return (
    <span className="public-bracket-player">
      <span className="public-bracket-avatar">{player?.avatar ? <img src={player.avatar} alt="" /> : <Icon name="user" size={13} />}</span>
      <span className="public-bracket-player-info"><strong>{player?.playerName || 'TBD'}</strong><small>{player?.playerCode || 'PGZ---'}</small></span>
    </span>
  )
}

function BracketMatch({ match, style }) {
  return (
    <article className="public-bracket-match" style={style}>
      <BracketPlayer player={match?.player1} />
      <BracketPlayer player={match?.player2} />
      {match?.status === 'finished' && <span className="public-bracket-score">{match.score1} : {match.score2}</span>}
    </article>
  )
}

function PublicBracket({ matches, text }) {
  const rounds = [
    { round: 0, count: 8, label: text.roundOf32 },
    { round: 1, count: 4, label: text.roundOf16 },
    { round: 2, count: 2, label: text.quarterFinals },
    { round: 3, count: 1, label: text.semiFinals },
  ]
  const byKey = new Map(matches.map((match) => [
    `${match.round}-${match.matchNumber}`,
    match,
  ]))
  const side = (reverse = false) => {
    const shownRounds = reverse ? [...rounds].reverse() : rounds
    return shownRounds.map(({ round: roundNumber, count, label }) => (
      <div className={`public-bracket-round public-bracket-round--${roundNumber}`} key={`${roundNumber}-${reverse}`}>
        <h3>{label}</h3>
        {Array.from({ length: count }, (_, index) => {
          const rowSpan = 8 / count
          const matchNumber = reverse
            ? count * 2 - index
            : index + 1
          const match = byKey.get(`${roundNumber}-${matchNumber}`)
          return <BracketMatch key={`${roundNumber}-${matchNumber}-${reverse}`} match={match} style={{ gridRow: `${index * rowSpan + 1} / span ${rowSpan}` }} />
        })}
      </div>
    ))
  }
  const final = byKey.get('4-1') || matches.find((match) => match.round === 4)
  return (
    <div className="public-bracket-scroll">
      <div className="public-bracket">
        <div className="public-bracket-side">{side()}</div>
        <div className="public-bracket-final"><h3>{text.final}</h3><BracketMatch match={final} /></div>
        <div className="public-bracket-side public-bracket-side--right">{side(true)}</div>
      </div>
    </div>
  )
}

function RegistrationPassCard({ entry, lang }) {
  const [imageUrl, setImageUrl] = useState('')
  const [loadError, setLoadError] = useState('')
  const [passCode, setPassCode] = useState('')
  const [codeError, setCodeError] = useState('')
  const [copied, setCopied] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    let active = true
    let objectUrl = ''
    if (!entry.id) {
      Promise.resolve().then(() => {
        if (active) setLoadError(lang === 'ET' ? 'የዲጂታል ፓስ መለያ አልተገኘም።' : 'The pass registration ID is missing.')
      })
      return () => { active = false }
    }
    const requestOptions = {
      credentials: 'include',
      cache: 'no-store',
    }
    fetch(`${API_BASE}/player/registrations/${encodeURIComponent(entry.id)}/pass`, requestOptions)
      .then(async (response) => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error || `Pass request failed (${response.status}).`)
        }
        const image = await response.blob()
        if (!image.type.startsWith('image/')) throw new Error('The server did not return a QR image.')
        return image
      })
      .then((image) => {
        if (!active) return
        objectUrl = URL.createObjectURL(image)
        setImageUrl(objectUrl)
      })
      .catch((error) => {
        if (active) setLoadError(error.message)
      })
    fetch(`${API_BASE}/player/registrations/${encodeURIComponent(entry.id)}/pass-code`, requestOptions)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `Pass code request failed (${response.status}).`)
        if (active) setPassCode(data.passCode || '')
      })
      .catch((error) => {
        if (active) setCodeError(error.message)
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [entry.id, lang, retryCount])

  async function copyPassCode() {
    if (!passCode) return
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(passCode)
        } catch {
          if (!copyTextToClipboard(passCode)) throw new Error('Clipboard access is unavailable.')
        }
      } else if (!copyTextToClipboard(passCode)) {
        throw new Error('Clipboard access is unavailable.')
      }
      setCopied(true)
      setCodeError('')
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCodeError(lang === 'ET' ? 'ኮዱን መቅዳት አልተቻለም።' : 'Could not copy the pass code. Select and copy it manually.')
    }
  }

  return (
    <div className="digital-pass-card">
      {imageUrl
        ? <a className="digital-pass-image-link" href={imageUrl} download={`prime-ethiopia-cup-${entry.id}-pass.png`} aria-label={lang === 'ET' ? `${entry.playerName} ዲጂታል ፓስ አውርድ` : `Download ${entry.playerName}'s digital pass`}>
          <img src={imageUrl} alt={`${entry.playerName} Prime Ethiopia Cup QR pass`} />
        </a>
        : <div className="digital-pass-placeholder" role={loadError ? 'alert' : 'status'}>
          {loadError || (lang === 'ET' ? 'የQR ፓስ በመጫን ላይ…' : 'Loading QR pass…')}
          {loadError && <button type="button" onClick={() => setRetryCount((count) => count + 1)}>{lang === 'ET' ? 'እንደገና ሞክር' : 'Try again'}</button>}
        </div>}
      <span>
        <strong>{lang === 'ET' ? 'ዲጂታል ፓስ' : 'Digital entry pass'}</strong>
        <small>{lang === 'ET' ? 'ለመግቢያ ይህን QR ኮድ ያሳዩ።' : 'Show this QR code at venue check-in.'}</small>
        {imageUrl && <a className="digital-pass-download" href={imageUrl} download={`prime-ethiopia-cup-${entry.id}-pass.png`}>{lang === 'ET' ? 'QR ኮዱን አውርድ' : 'Download QR pass'}</a>}
        {passCode && <code className="digital-pass-code">{passCode}</code>}
        {passCode && <button className="digital-pass-copy" type="button" onClick={copyPassCode}>{copied ? (lang === 'ET' ? 'ተቀድቷል!' : 'Copied!') : (lang === 'ET' ? 'ኮዱን ቅዳ' : 'Copy pass code')}</button>}
        {codeError && <small className="digital-pass-error" role="alert">{codeError}</small>}
      </span>
    </div>
  )
}

function ProfileTab({
  registration, registrations, player, schedule, onRegister, onLogout, onProfileSave,
  onAccountDelete, lang, avatar, onAvatarChange, avatarError, scheduleError, selectedWeek, authenticated,
  profileCommand, onProfileCommandHandled, supportUrl, activeRegistration,
}) {
  const text = translations[lang]
  const [profileOpen, setProfileOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [profileDetails, setProfileDetails] = useState({ displayName: player?.displayName || '', psnId: player?.psnId || '' })
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [bracketOpen, setBracketOpen] = useState(false)
  const [bracketMatches, setBracketMatches] = useState([])
  const [bracketError, setBracketError] = useState('')
  const [bracketLoading, setBracketLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const accountRegistrations = registrations.length ? registrations : (registration ? [registration] : [])
  const displayName = player?.displayName || accountRegistrations[0]?.playerName || text.player
  const playerCode = player?.playerCode || accountRegistrations[0]?.playerCode
  const scheduleWeek = schedule.find((week) => week.id === (activeRegistration?.weekId ?? selectedWeek))

  useEffect(() => {
    if (!profileOpen) return undefined
    function closeOnEscape(event) {
      if (event.key === 'Escape') {
        if (deleteOpen) setDeleteOpen(false)
        else setProfileOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [profileOpen, deleteOpen])

  useEffect(() => {
    if (!profileCommand) return
    const frame = window.requestAnimationFrame(() => {
      if (profileCommand === 'edit') {
        setProfileDetails({ displayName: player?.displayName || '', psnId: player?.psnId || '' })
        setEditing(true)
        setProfileOpen(true)
      } else if (profileCommand === 'delete') {
        setProfileError('')
        setDeletePassword('')
        setDeleteOpen(true)
        setProfileOpen(true)
      } else if (profileCommand === 'tournaments') {
        document.getElementById('registered-tournaments')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      onProfileCommandHandled()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [profileCommand, player, onProfileCommandHandled])

  async function loadBracket() {
    if (!scheduleWeek) return
    setBracketLoading(true)
    setBracketError('')
    try {
      const response = await fetch(`${API_BASE}/tournaments/${scheduleWeek.id}/fixtures`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Bracket request failed (${response.status}).`)
      setBracketMatches(data.matches || [])
      setBracketOpen(true)
    } catch (error) {
      setBracketError(error.message)
    } finally {
      setBracketLoading(false)
    }
  }

  async function saveProfile(event) {
    event.preventDefault()
    setProfileError('')
    try {
      await onProfileSave(profileDetails)
      setEditing(false)
    } catch (error) {
      setProfileError(error.message)
    }
  }

  async function deleteAccount(event) {
    event.preventDefault()
    setProfileError('')
    try {
      await onAccountDelete(deletePassword)
      setDeleteOpen(false)
      setProfileOpen(false)
    } catch (error) {
      setProfileError(error.message)
    }
  }

  async function copyPlayerCode() {
    if (!playerCode) return
    try {
      await navigator.clipboard.writeText(playerCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      setProfileError(error.message)
    }
  }

  return (
    <section className="tab-panel profile-tab" aria-labelledby="profile-title">
      <div className="page-intro">
        <span className="eyebrow">{text.profileHub}</span>
        <h1 id="profile-title">{text.matchCenter}</h1>
        <p>{text.profileDescription}</p>
      </div>

      <button className="player-card player-card--interactive" type="button" onClick={() => setProfileOpen(true)} aria-haspopup="dialog">
        <div className="player-card-glow" aria-hidden="true" />
        <div className="player-avatar">{avatar ? <img src={avatar} alt="" /> : displayName.trim().slice(0, 1).toUpperCase()}</div>
        <div className="player-identity"><small>{text.primePlayer}</small><h2>{displayName}</h2><p><Icon name="gamepad" size={14} /> {player?.psnId || accountRegistrations[0]?.psnId || text.psnNotConnected}</p></div>
        <span className="psn-badge"><i>PS</i> {authenticated ? text.online : text.player}</span>
      </button>
      {playerCode && <div className="profile-code-inline"><span><small>{text.playerCode}</small><strong>{playerCode}</strong></span><button type="button" onClick={copyPlayerCode}>{copied ? text.copied : text.copyCode}</button></div>}

      {!activeRegistration && <section className="section-block weekly-schedule" aria-label={text.weeklySchedule}>
        <SectionHeading kicker={text.selectWeek} title={text.weeklySchedule} />
        <TournamentScheduleCards schedule={schedule} text={text} lang={lang} selectedWeek={selectedWeek} onRegister={onRegister} />
        {scheduleError && <p className="schedule-error" role="status">{scheduleError}</p>}
        <div className="weekly-match-hours">
          <span className="weekly-hours-icon"><Icon name="clock" size={18} /></span>
            <span><strong>{text.dailyHours}</strong><b>{text.scheduleHours}</b><small>{text.matchesPerDay}</small></span>
        </div>
      </section>}

      <section className="section-block" id="registered-tournaments">
        <SectionHeading kicker={text.competition} title={text.registeredTournaments} />
        {accountRegistrations.length ? accountRegistrations.map((entry) => (
          <article className="registered-card" key={entry.id || entry.confirmationCode}>
            <span className="registered-icon"><Icon name="trophy" size={19} /></span>
            <span className="registered-copy">
              <small>{entry.tournament?.name || schedule.find((week) => week.id === entry.weekId)?.name || `${text.week} ${entry.weekId + 1}`}{entry.registeredForOthers && <b className="registration-for-other-badge">{lang === 'ET' ? 'በእርስዎ የተመዘገበ' : 'Registered by you'}</b>}</small>
              <strong>{entry.playerName}</strong>
              <span>{entry.tournament?.dateRange || entry.confirmationCode}</span>
              {entry.contact && <span>{entry.contact}</span>}
              {entry.paymentStatus === 'approved' && <span>{lang === 'ET' ? 'ፓስ' : 'Pass'} · {entry.passStage?.replaceAll('_', ' ') || 'not started'}</span>}
              {entry.paymentStatus === 'rejected' && entry.rejectionReason && <span>{lang === 'ET' ? 'ምክንያት' : 'Reason'}: {entry.rejectionReason}</span>}
            </span>
            <span className={`pending-badge pending-badge--${entry.paymentStatus}`}><i /> {entry.paymentStatus === 'approved'
              ? (lang === 'ET' ? 'ክፍያ ጸድቋል' : 'Payment approved')
              : entry.paymentStatus === 'rejected'
                ? (lang === 'ET' ? 'ክፍያ ተከልክሏል' : 'Payment rejected')
                : (lang === 'ET' ? 'ክፍያ በመጠባበቅ ላይ' : 'Pending approval')}</span>
            {entry.hasPass && <RegistrationPassCard entry={entry} lang={lang} />}
          </article>
        )) : (
          <div className="empty-state"><span className="empty-icon"><Icon name="ticket" size={21} /></span><strong>{text.noRegistrations}</strong><span>{text.nextCompetition}</span><button type="button" onClick={() => onRegister(selectedWeek)}>{text.exploreRegistration} <Icon name="arrow" size={15} /></button></div>
        )}
      </section>

      <section className="section-block bracket-section">
        <SectionHeading kicker={text.roadToCup} title={text.matchBracket} />
        <div className="bracket-card">
          <div className="bracket-header"><span><Icon name="bracket" size={17} /> {text.knockout}</span><button type="button" onClick={loadBracket} disabled={bracketLoading}>{bracketLoading ? text.loading : text.preview}</button></div>
          {bracketError && <p className="schedule-error" role="alert">{bracketError}</p>}
          {bracketOpen ? <PublicBracket matches={bracketMatches} text={text} /> : <p>{text.matchupNotice}</p>}
          {bracketOpen && !bracketMatches.length && <p>{text.noBracketYet}</p>}
        </div>
      </section>

      <PlayerDisputeForm activeRegistration={activeRegistration} />

      <section className="support-card">
        <span className="support-icon"><Icon name="support" size={20} /></span>
        <span>
          <small>{text.needHelp}</small>
          <strong>{text.contactSupport}</strong>
          <p>{text.supportDescription}</p>
          {supportUrl
            ? <a href={supportUrl} target="_blank" rel="noreferrer">{text.contactAdmin} <Icon name="arrow" size={13} /></a>
            : <span className="support-unavailable">{text.supportUnavailable}</span>}
        </span>
      </section>

      {profileOpen && createPortal(
        <div className="profile-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setProfileOpen(false)}>
          <section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="player-details-title">
            <button className="rules-modal-close" type="button" aria-label={text.close} onClick={() => setProfileOpen(false)}><Icon name="close" size={20} /></button>
            <span className="eyebrow">{text.profileHub}</span><h2 id="player-details-title">{displayName}</h2>
            {playerCode && <div className="profile-code-row"><strong>{playerCode}</strong><button type="button" onClick={copyPlayerCode}>{copied ? text.copied : text.copyCode}</button></div>}
            <h3>{text.registeredTournaments}</h3>
            {accountRegistrations.length
              ? accountRegistrations.map((entry) => (
                <article className="profile-registration-pass" key={entry.id || entry.confirmationCode}>
                  <div><strong>{entry.playerName}</strong><span>{entry.tournament?.name || entry.confirmationCode} · {entry.paymentStatus}</span>
                    {entry.registeredForOthers && <small>{lang === 'ET' ? 'በእርስዎ የተመዘገበ' : 'Registered by you'}</small>}
                    {entry.contact && <small>{entry.contact}</small>}
                    {entry.paymentStatus === 'rejected' && entry.rejectionReason && <small>{lang === 'ET' ? 'ምክንያት' : 'Reason'}: {entry.rejectionReason}</small>}
                    {entry.checkInStatus === 'checked_in' && <small>{lang === 'ET' ? 'ገብቷል · ዝግጁ' : 'Checked in · Ready'}</small>}
                    {entry.passStage && entry.passStage !== 'not_started' && <small>{lang === 'ET' ? 'የፓስ ደረጃ' : 'Pass stage'}: {entry.passStage.replaceAll('_', ' ')}</small>}
                  </div>
                  {entry.hasPass && <RegistrationPassCard entry={entry} lang={lang} />}
                </article>
              ))
              : <p>{text.noRegistrations}</p>}
            {authenticated && <button className="admin-primary" type="button" onClick={() => {
              setProfileDetails({ displayName: player?.displayName || '', psnId: player?.psnId || '' })
              setEditing((open) => !open)
            }}>{text.editProfile}</button>}
            {editing && <form className="profile-edit-form" onSubmit={saveProfile}>
              <label>{text.displayName}<input maxLength={60} value={profileDetails.displayName} onChange={(event) => setProfileDetails({ ...profileDetails, displayName: event.target.value })} required /></label>
              <label>{text.psnId}<input maxLength={64} value={profileDetails.psnId} onChange={(event) => setProfileDetails({ ...profileDetails, psnId: event.target.value })} /></label>
              <label className="avatar-upload"><Icon name="user" size={18} /><span>{text.uploadAvatar}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={onAvatarChange} /></label>
              {avatarError && <p className="avatar-error" role="alert">{avatarError}</p>}
              {profileError && <p className="schedule-error" role="alert">{profileError}</p>}
              <button className="primary-button full-button" type="submit">{text.saveProfile}</button>
            </form>}
            {authenticated && !deleteOpen && <button className="admin-danger-quiet profile-delete-button" type="button" onClick={() => setDeleteOpen(true)}>{text.deleteAccount}</button>}
            {deleteOpen && <div className="account-delete-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setDeleteOpen(false)}>
              <form className="account-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-account-title" onSubmit={deleteAccount}>
                <span className="account-delete-icon"><Icon name="trash" size={20} /></span>
                <h3 id="delete-account-title">{text.deleteConfirmTitle}</h3>
                <p>{text.deleteAccountPrompt}</p>
                <label>{text.password}<input type="password" autoComplete="current-password" value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} required /></label>
                {profileError && <p className="schedule-error" role="alert">{profileError}</p>}
                <div className="account-delete-actions">
                  <button type="button" onClick={() => setDeleteOpen(false)}>{text.cancel}</button>
                  <button className="admin-danger-quiet" type="submit">{text.deleteAccountConfirm}</button>
                </div>
              </form>
            </div>}
            {authenticated && <button className="profile-signout" type="button" onClick={async () => {
              try {
                await onLogout()
                setProfileOpen(false)
              } catch (error) {
                setProfileError(error.message)
              }
            }}>{text.signOut}</button>}
          </section>
        </div>,
        document.body,
      )}
    </section>
  )
}

function LoginModal({ lang, mode, form, onChange, onModeChange, onClose, onSubmit, error, busy }) {
  const text = translations[lang]
  const isRegister = mode === 'register'

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    createPortal(<div className="login-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <button className="login-close" type="button" onClick={onClose} aria-label={text.close}><Icon name="close" size={18} /></button>
        <span className="login-modal-icon"><Icon name="login" size={21} /></span>
        <span className="eyebrow">{text.profileHub}</span>
        <h2 id="login-title">{isRegister ? text.registerAccount : text.signIn}</h2>
        <p className="login-note">{text.localProfile}</p>
        <form onSubmit={onSubmit}>
          {isRegister && <>
            <label htmlFor="auth-display-name">{text.displayName}</label>
            <input id="auth-display-name" name="displayName" value={form.displayName} onChange={onChange} autoComplete="name" maxLength={60} required />
          </>}
          <label htmlFor="auth-phone">{text.phone}</label>
          <input id="auth-phone" name="phone" type="tel" value={form.phone} onChange={onChange} autoComplete="tel" inputMode="tel" placeholder={text.phonePlaceholder} required />
          <label htmlFor="auth-password">{text.password}</label>
          <input id="auth-password" name="password" type="password" value={form.password} onChange={onChange} autoComplete={isRegister ? 'new-password' : 'current-password'} minLength="8" required />
          {isRegister && <>
            <label htmlFor="auth-telegram">{text.telegramUsername}</label>
            <input id="auth-telegram" name="telegramUsername" value={form.telegramUsername} onChange={onChange} autoComplete="off" placeholder="@username" maxLength={33} pattern="@?[A-Za-z0-9_]{5,32}" />
          </>}
          {error && <p className="registration-error" role="alert">{error}</p>}
          <button className="primary-button full-button" type="submit" disabled={busy}><Icon name="login" size={16} /> {busy ? text.loading : isRegister ? text.createAccount : text.continue}</button>
        </form>
        <nav className="auth-links" aria-label={text.profileHub}>
          {isRegister
            ? <button type="button" onClick={() => onModeChange('login')}>{text.haveAccount}</button>
            : <button type="button" onClick={() => onModeChange('register')}>{text.noAccount}</button>}
          <a href="https://t.me/" target="_blank" rel="noreferrer">{text.forgotPassword}</a>
        </nav>
        <p className="auth-support-note">{text.supportContact}</p>
      </section>
    </div>, document.body)
  )
}

function App({ loading = false, authChecking = false, loadingMessage }) {
  const [activeTab, setActiveTab] = useState('home')
  const [navHidden, setNavHidden] = useState(false)
  const [lang, setLang] = useState('EN')
  const [showLogin, setShowLogin] = useState(false)
  const [authMode, setAuthMode] = useState('login')
  const sessionGenerationRef = useRef(0)
  const [loginForm, setLoginForm] = useState({ displayName: '', phone: '', password: '', telegramUsername: '' })
  const [avatar, setAvatar] = useState('')
  const [avatarError, setAvatarError] = useState('')
  const [player, setPlayer] = useState(null)
  const [activeRegistration, setActiveRegistration] = useState(null)
  const theme = 'dark'
  const [customBackground, setCustomBackground] = useState(() => window.localStorage.getItem('prime-chat-background') || '')
  const [playerRegistrations, setPlayerRegistrations] = useState([])
  const [profileCommand, setProfileCommand] = useState(null)
  const [notifications, setNotifications] = useState([])
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0)
  const [notificationsLoading, setNotificationsLoading] = useState(false)
  const [notificationsError, setNotificationsError] = useState('')
  const [schedule, setSchedule] = useState([])
  const [scheduleError, setScheduleError] = useState('')
  const [supportUrl, setSupportUrl] = useState(() => {
    return /^[A-Za-z0-9_]{5,32}$/.test(SUPPORT_TELEGRAM) ? `https://t.me/${SUPPORT_TELEGRAM}` : ''
  })
  const [authError, setAuthError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [isOffline, setIsOffline] = useState(() => !navigator.onLine)
  const [form, setForm] = useState({ playerName: '', contact: '', payment: '', telegramUsername: '', sessionPreference: 'any' })
  const [extraParticipants, setExtraParticipants] = useState([])
  const [addingToActive, setAddingToActive] = useState(false)
  const [paymentAccounts, setPaymentAccounts] = useState([])
  const [copiedAccount, setCopiedAccount] = useState('')
  const [copyAccountError, setCopyAccountError] = useState('')
  const [registration, setRegistration] = useState(null)
  const [receiptData, setReceiptData] = useState('')
  const [receiptName, setReceiptName] = useState('')
  const [receiptError, setReceiptError] = useState('')
  const [registrationError, setRegistrationError] = useState('')
  const [submittingRegistration, setSubmittingRegistration] = useState(false)
  const [selectedWeek, setSelectedWeek] = useState(0)
  const [submitted, setSubmitted] = useState(false)
  const text = translations[lang]

  useEffect(() => {
    let active = true
    playerRequest('/tournaments/weeks')
      .then((data) => {
        if (active) {
          setSchedule(mapTournamentSchedule(data.weeks))
          setScheduleError('')
          if (data.weeks.length) setSelectedWeek((current) => data.weeks.some((week) => week.weekId === current) ? current : data.weeks[0].weekId)
        }
      })
      .catch((error) => {
        if (active) setScheduleError(error.message)
      })
    playerRequest('/player/session')
      .then((data) => {
        if (!active) return
        if (!data.authenticated) {
          setPlayer(null)
          setPlayerRegistrations([])
          setActiveRegistration(null)
          return
        }
        setPlayer(data.player)
        setAvatar(data.player.avatar || '')
        setPlayerRegistrations(data.registrations || [])
        setActiveRegistration(data.activeRegistration || null)
        setForm((current) => ({
          ...current,
          playerName: data.player.displayName || current.playerName,
          contact: data.player.contact || current.contact,
          telegramUsername: data.player.telegramUsername ? `@${data.player.telegramUsername.replace(/^@/, '')}` : current.telegramUsername,
        }))
        setRegistration(null)
      })
      .catch((error) => {
        if (active && !/sign-in is required/i.test(error.message)) setAuthError(error.message)
      })
    playerRequest('/payment-accounts')
      .then((data) => {
        if (active) setPaymentAccounts(data.accounts || [])
      })
      .catch((error) => {
        if (active) setRegistrationError(error.message)
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!player?.id) return undefined
    let active = true
    playerRequest('/player/chat/background')
      .then(({ imageData }) => {
        if (!active) return
        const key = `prime-chat-background:player:${player.id}`
        if (imageData) window.localStorage.setItem(key, imageData)
        else window.localStorage.removeItem(key)
        setCustomBackground(imageData || '')
      })
      .catch((error) => console.warn('Player background could not be loaded:', error.message))
    return () => { active = false }
  }, [player?.id])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [])

  useEffect(() => {
    const updateBackground = (event) => setCustomBackground(event.detail || '')
    window.addEventListener('prime-chat-background-change', updateBackground)
    return () => window.removeEventListener('prime-chat-background-change', updateBackground)
  }, [])

  useEffect(() => {
    function handleInteractivePointer(event) {
      const target = event.target
      if (target instanceof Element && target.closest('button:not(:disabled), a[role="button"]')) {
        playInteractionFeedback()
      }
    }
    document.addEventListener('pointerdown', handleInteractivePointer, true)
    return () => document.removeEventListener('pointerdown', handleInteractivePointer, true)
  }, [])

  useEffect(() => {
    if (SUPPORT_TELEGRAM) return
    let active = true
    fetch(`${API_BASE}/health`)
      .then((response) => {
        if (!response.ok) throw new Error(`Support endpoint request failed (${response.status}).`)
        return response.json()
      })
      .then((data) => {
        if (active && /^[A-Za-z0-9_]{5,32}$/.test(data.bot?.username || '')) {
          setSupportUrl(`https://t.me/${data.bot.username}`)
        }
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  const playerId = player?.id
  const currentWeekId = addingToActive ? selectedWeek : activeRegistration?.weekId ?? selectedWeek
  const scopedSchedule = activeRegistration && !addingToActive
    ? schedule.filter((week) => week.id === activeRegistration.weekId)
    : schedule

  useEffect(() => {
    if (!playerId) return undefined
    let active = true
    const refreshSession = async () => {
      const requestGeneration = sessionGenerationRef.current
      try {
        const [data, scheduleData] = await Promise.all([
          playerRequest('/player/session'),
          playerRequest('/tournaments/weeks'),
        ])
        if (!active || requestGeneration !== sessionGenerationRef.current) return
        if (!data.authenticated) {
          setPlayer(null)
          setAvatar('')
          setPlayerRegistrations([])
          setActiveRegistration(null)
          return
        }
        setPlayerRegistrations(data.registrations || [])
        setActiveRegistration(data.activeRegistration || null)
        setSchedule(mapTournamentSchedule(scheduleData.weeks))
        setScheduleError('')
      } catch (error) {
        if (!active || requestGeneration !== sessionGenerationRef.current) return
        setAuthError(error.message)
      }
    }
    const timer = window.setInterval(refreshSession, 30_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [playerId])

  const loadNotifications = useCallback(async () => {
    if (!playerId) return
    setNotificationsLoading(true)
    setNotificationsError('')
    try {
      const data = await playerRequest('/player/notifications')
      setNotifications(data.notifications || [])
      setUnreadNotificationCount(data.unreadCount || 0)
    } catch (error) {
      setNotificationsError(error.message)
    } finally {
      setNotificationsLoading(false)
    }
  }, [playerId])

  useEffect(() => {
    if (!playerId) return undefined
    const initialLoad = window.setTimeout(loadNotifications, 0)
    const refreshTimer = window.setInterval(loadNotifications, 60_000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(refreshTimer)
    }
  }, [playerId, loadNotifications])

  useEffect(() => {
    function handleOnline() {
      setIsOffline(false)
    }

    function handleOffline() {
      setIsOffline(true)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  useEffect(() => {
    let scrollStopTimer

    function hideNavUntilScrollStops() {
      setNavHidden(true)
      window.clearTimeout(scrollStopTimer)
      scrollStopTimer = window.setTimeout(() => setNavHidden(false), 1100)
    }

    window.addEventListener('scroll', hideNavUntilScrollStops, { passive: true })
    window.addEventListener('wheel', hideNavUntilScrollStops, { passive: true })
    window.addEventListener('touchmove', hideNavUntilScrollStops, { passive: true })
    return () => {
      window.removeEventListener('scroll', hideNavUntilScrollStops)
      window.removeEventListener('wheel', hideNavUntilScrollStops)
      window.removeEventListener('touchmove', hideNavUntilScrollStops)
      window.clearTimeout(scrollStopTimer)
    }
  }, [])

  function navigate(tab) {
    setNavHidden(false)
    setActiveTab(tab)
  }

  function openProfileAction(action) {
    setProfileCommand(action)
    navigate('profile')
  }

  const handleProfileCommandHandled = useCallback(() => setProfileCommand(null), [])

  async function markNotificationRead(notificationId) {
    try {
      const data = await playerRequest(`/player/notifications/${notificationId}/read`, { method: 'PATCH' })
      setNotifications((current) => current.map((notification) => (
        String(notification.id) === String(notificationId)
          ? { ...notification, isRead: true }
          : notification
      )))
      setUnreadNotificationCount(data.unreadCount || 0)
      setNotificationsError('')
    } catch (error) {
      setNotificationsError(error.message)
    }
  }

  async function markAllNotificationsRead() {
    try {
      const data = await playerRequest('/player/notifications/read-all', { method: 'PATCH' })
      setNotifications((current) => current.map((notification) => ({ ...notification, isRead: true })))
      setUnreadNotificationCount(data.unreadCount || 0)
      setNotificationsError('')
    } catch (error) {
      setNotificationsError(error.message)
    }
  }

  function updateLoginForm(event) {
    const { name, value } = event.target
    setLoginForm((current) => ({ ...current, [name]: value }))
  }

  async function signIn(event) {
    event.preventDefault()
    const requestGeneration = ++sessionGenerationRef.current
    setAuthBusy(true)
    setAuthError('')
    try {
      await playerRequest(`/player/${authMode}`, {
        method: 'POST',
        body: JSON.stringify({
          displayName: loginForm.displayName.trim(),
          contact: loginForm.phone.trim(),
          password: loginForm.password,
          telegramUsername: loginForm.telegramUsername.trim(),
        }),
      })
      const data = await playerRequest('/player/session')
      if (requestGeneration !== sessionGenerationRef.current) return
      if (!data.authenticated) throw new Error('Sign-in could not be verified. Please try again.')
      setPlayer(data.player)
      setAvatar(data.player.avatar || '')
      setPlayerRegistrations(data.registrations || [])
      setActiveRegistration(data.activeRegistration || null)
      setForm((current) => ({
        ...current,
        playerName: data.player.displayName || current.playerName,
        contact: data.player.contact || current.contact,
        telegramUsername: data.player.telegramUsername ? `@${data.player.telegramUsername.replace(/^@/, '')}` : current.telegramUsername,
      }))
      setLoginForm({ displayName: '', phone: '', password: '', telegramUsername: '' })
      setShowLogin(false)
    } catch (error) {
      setAuthError(error.message)
    } finally {
      setAuthBusy(false)
    }
  }

  async function changeAvatar(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setAvatarError(lang === 'ET' ? 'እባክዎ የምስል ፋይል ይምረጡ።' : 'Please select an image file.')
      event.target.value = ''
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setAvatarError(lang === 'ET' ? 'የምስል መጠኑ ከ5 MB በታች መሆን አለበት።' : 'Image must be smaller than 5 MB.')
      event.target.value = ''
      return
    }
    setAvatarError('')
    try {
      const source = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read image.'))
        reader.onerror = () => reject(new Error('Could not read image.'))
        reader.readAsDataURL(file)
      })
      const image = await new Promise((resolve, reject) => {
        const loadedImage = new Image()
        loadedImage.onload = () => resolve(loadedImage)
        loadedImage.onerror = () => reject(new Error('Could not process image.'))
        loadedImage.src = source
      })
      const canvas = document.createElement('canvas')
      const scale = Math.min(1, 256 / Math.max(image.width, image.height))
      canvas.width = Math.round(image.width * scale)
      canvas.height = Math.round(image.height * scale)
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
      const compressedAvatar = canvas.toDataURL('image/webp', 0.82)
      const data = await playerRequest('/player/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: player.displayName,
          psnId: player.psnId || '',
          avatar: compressedAvatar,
        }),
      })
      setPlayer(data.player)
      setAvatar(data.player.avatar)
    } catch (error) {
      setAvatarError(error.message)
    } finally {
      event.target.value = ''
    }
  }

  async function savePlayerProfile(details) {
    const data = await playerRequest('/player/profile', {
      method: 'PATCH',
      body: JSON.stringify({ ...details, avatar }),
    })
    setPlayer(data.player)
  }

  async function logoutPlayer() {
    ++sessionGenerationRef.current
    await playerRequest('/player/session', { method: 'DELETE' })
    setPlayer(null)
    setAvatar('')
    setPlayerRegistrations([])
    setActiveRegistration(null)
    setNotifications([])
    setUnreadNotificationCount(0)
    setNotificationsError('')
    setRegistration(null)
    setExtraParticipants([])
    setAddingToActive(false)
    setReceiptData('')
    setReceiptName('')
    setForm((current) => ({ ...current, playerName: '', contact: '', payment: '', telegramUsername: '' }))
    setSubmitted(false)
  }

  async function deletePlayerAccount(password) {
    await playerRequest('/player/account', {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    })
    setPlayer(null)
    setAvatar('')
    setPlayerRegistrations([])
    setActiveRegistration(null)
    setNotifications([])
    setUnreadNotificationCount(0)
    setNotificationsError('')
    setRegistration(null)
    setExtraParticipants([])
    setAddingToActive(false)
    setReceiptData('')
    setReceiptName('')
    try {
      const scheduleData = await playerRequest('/tournaments/weeks')
      setSchedule(mapTournamentSchedule(scheduleData.weeks))
    } catch (error) {
      setScheduleError(error.message)
    }
  }

  function updateForm(event) {
    setSubmitted(false)
    setRegistrationError('')
    const { name, value } = event.target
    setForm((current) => ({ ...current, [name]: value }))
  }

  function addGroupParticipant() {
    if (!player) {
      setShowLogin(true)
      return
    }
    if (extraParticipants.length + 1 >= 128) return
    setExtraParticipants((current) => [...current, createEmptyGroupParticipant()])
  }

  function addPlayerToActiveTournament() {
    if (!player) {
      setShowLogin(true)
      return
    }
    const firstAvailableWeek = schedule.find((week) => (
      ['open', 'full'].includes(week.status) && week.remaining > 0
    ))
    setSelectedWeek(firstAvailableWeek?.id ?? schedule[0]?.id ?? selectedWeek)
    const firstParticipant = createEmptyGroupParticipant()
    setAddingToActive(true)
    setExtraParticipants([firstParticipant])
    setRegistration(null)
    setRegistrationError('')
    setReceiptError('')
    setReceiptData('')
    setReceiptName('')
    setSubmitted(false)
    setNavHidden(false)
  }

  function cancelAddToActiveTournament() {
    setAddingToActive(false)
    setExtraParticipants([])
    setReceiptData('')
    setReceiptName('')
    setReceiptError('')
    setRegistrationError('')
    setSubmitted(false)
  }

  function updateGroupParticipant(id, key, value) {
    setExtraParticipants((current) => current.map((participant) => (
      participant.id === id ? { ...participant, [key]: value } : participant
    )))
  }

  async function copyPaymentAccount(account) {
    setCopyAccountError('')
    try {
      const copied = await writeClipboardText(account.number)
      if (!copied) throw new Error('Clipboard access is unavailable.')
      setCopiedAccount(account.type)
      window.setTimeout(() => setCopiedAccount((current) => current === account.type ? '' : current), 1800)
    } catch {
      setCopiedAccount('')
      setCopyAccountError(lang === 'ET' ? 'የአካውንት ቁጥሩን መቅዳት አልተቻለም።' : 'Could not copy the account number. Please select and copy it manually.')
    }
  }

  function changeReceipt(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setReceiptError(text.receiptInvalid)
      setReceiptData('')
      setReceiptName('')
      event.target.value = ''
      return
    }
    setReceiptData('')
    setReceiptName('')
    setReceiptError('')
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setReceiptData(reader.result)
        setReceiptName(file.name)
      } else {
        setReceiptData('')
        setReceiptName('')
        setReceiptError(lang === 'ET' ? 'ደረሰኙን ማንበብ አልተቻለም።' : 'The receipt image could not be read.')
      }
    }
    reader.onerror = () => {
      setReceiptData('')
      setReceiptName('')
      setReceiptError(lang === 'ET' ? 'ደረሰኙን ማንበብ አልተቻለም።' : 'The receipt image could not be read.')
    }
    reader.readAsDataURL(file)
  }

  async function register(event) {
    event.preventDefault()
    setSubmittingRegistration(true)
    setRegistrationError('')
    try {
      if (!receiptData) {
        throw new Error(lang === 'ET' ? 'ከመመዝገብዎ በፊት የክፍያ ደረሰኝ ይጫኑ።' : 'Upload a payment receipt before submitting this registration.')
      }
      const isGroupCheckout = Boolean(player)
      const additionalPlayers = extraParticipants.map(({ playerName, contact, telegramUsername, sessionPreference }) => ({
        playerName: playerName.trim(),
        contact: contact.trim(),
        telegramUsername: telegramUsername.trim().replace(/^@/, ''),
        sessionPreference,
      }))
      if (addingToActive && additionalPlayers.length === 0) {
        throw new Error(lang === 'ET' ? 'ከመቀጠልዎ በፊት ተጨማሪ ተጫዋች ያክሉ።' : 'Add at least one player before continuing.')
      }
      const response = await fetch(`${API_BASE}${isGroupCheckout ? '/registrations/group' : '/registrations'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isGroupCheckout ? {
          payment: form.payment,
          weekId: addingToActive ? selectedWeek : currentWeekId,
          receiptData,
          registeredForOthers: addingToActive,
          participants: addingToActive ? additionalPlayers : [
            { playerName: form.playerName.trim(), telegramUsername: form.telegramUsername.trim().replace(/^@/, ''), sessionPreference: form.sessionPreference },
            ...additionalPlayers,
          ],
        } : {
          playerName: form.playerName.trim(),
          contact: form.contact.trim(),
          telegramUsername: form.telegramUsername.trim().replace(/^@/, ''),
          sessionPreference: form.sessionPreference,
          payment: form.payment,
          weekId: currentWeekId,
          receiptData,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Registration request failed (${response.status}).`)
      setRegistration({
        ...(data.registration || data.registrations?.[0]),
        registrations: data.registrations || [data.registration],
        weekId: selectedWeek,
        payment: form.payment,
        contact: form.contact.trim(),
        playerName: form.playerName.trim(),
      })
      const registeredWeekId = addingToActive ? selectedWeek : currentWeekId
      const registeredCount = isGroupCheckout ? (data.registrations?.length || 0) : 1
      setExtraParticipants([])
      setAddingToActive(false)
      setReceiptData('')
      setReceiptName('')
      setSchedule((current) => current.map((week) => week.id === registeredWeekId
        ? { ...week, remaining: Math.max(0, week.remaining - registeredCount), filled: Math.min(week.capacity, week.filled + registeredCount), status: week.remaining <= registeredCount ? 'full' : week.status }
        : week))
      playerRequest('/tournaments/weeks')
        .then((scheduleData) => setSchedule(mapTournamentSchedule(scheduleData.weeks)))
        .catch((error) => setScheduleError(error.message))
      setSubmitted(true)
      if (player) {
        playerRequest('/player/session')
          .then((session) => {
            if (!session.authenticated) {
              setPlayer(null)
              setAvatar('')
              setPlayerRegistrations([])
              setActiveRegistration(null)
              return
            }
            setPlayerRegistrations(session.registrations || [])
            setActiveRegistration(session.activeRegistration || null)
          })
          .catch((error) => setAuthError(error.message))
      }
    } catch (error) {
      setRegistrationError(error.message)
    } finally {
      setSubmittingRegistration(false)
    }
  }

  if (window.location.pathname.replace(/\/+$/, '') === '/admin') {
    return <AdminDashboard />
  }
  if (window.location.pathname.replace(/\/+$/, '') === '/staff') {
    return <StaffConsole />
  }

  return (
    <main
      className="app-shell"
      lang={lang === 'ET' ? 'am' : 'en'}
      data-theme={theme}
      style={{ '--custom-app-wallpaper': customBackground ? `url("${customBackground}")` : 'none' }}
    >
      <div className="field-overlay" aria-hidden="true" />
      <div className="ambient-glow ambient-glow--one" aria-hidden="true" />
      <div className="ambient-glow ambient-glow--two" aria-hidden="true" />
      <Header
        lang={lang}
        onLanguageChange={setLang}
        player={player}
        avatar={avatar}
        unreadCount={unreadNotificationCount}
        notifications={notifications}
        notificationsLoading={notificationsLoading}
        notificationsError={notificationsError}
        onRefreshNotifications={loadNotifications}
        onMarkNotificationRead={markNotificationRead}
        onMarkAllNotificationsRead={markAllNotificationsRead}
        onProfileAction={openProfileAction}
        onLogout={logoutPlayer}
        onHome={() => navigate('home')}
        onLogin={() => {
          setAuthMode('login')
          setAuthError('')
          setShowLogin(true)
        }}
      />

      <div className="page-content" key={activeTab}>
        {activeTab === 'home' && <HomeTab onNavigate={navigate} lang={lang} schedule={scopedSchedule} scheduleError={scheduleError} activeRegistration={activeRegistration} />}
        {activeTab === 'tournament' && <TournamentTab onRegister={(weekId) => {
          setSelectedWeek(weekId ?? currentWeekId)
          navigate('register')
        }} lang={lang} schedule={scopedSchedule} scheduleError={scheduleError} selectedWeek={currentWeekId} activeRegistration={activeRegistration} />}
        {activeTab === 'register' && <RegistrationTab form={form} onChange={updateForm} onSubmit={register} submitted={submitted} submitting={submittingRegistration} submitError={receiptError || registrationError} copyAccountError={copyAccountError} receiptName={receiptName} onReceiptChange={changeReceipt} lang={lang} selectedWeek={currentWeekId} onWeekChange={setSelectedWeek} schedule={scopedSchedule} scheduleError={scheduleError} activeRegistration={activeRegistration} addingToActive={addingToActive} onAddToActive={addPlayerToActiveTournament} onCancelAddToActive={cancelAddToActiveTournament} player={player} participants={extraParticipants} onAddParticipant={addGroupParticipant} onParticipantChange={updateGroupParticipant} onRemoveParticipant={(id) => setExtraParticipants((current) => current.filter((item) => item.id !== id))} paymentAccounts={paymentAccounts} onCopyAccount={copyPaymentAccount} copiedAccount={copiedAccount} totalEntryFee={Number(scopedSchedule.find((week) => week.id === currentWeekId)?.entryFee ?? 1500) * (addingToActive ? extraParticipants.length : extraParticipants.length + 1)} />}
        {activeTab === 'profile' && <ProfileTab registration={registration} registrations={playerRegistrations} player={player} schedule={scopedSchedule} onRegister={(weekId) => {
          setSelectedWeek(weekId ?? currentWeekId)
          navigate('register')
        }} onLogout={logoutPlayer} onProfileSave={savePlayerProfile} onAccountDelete={deletePlayerAccount} lang={lang} avatar={avatar} onAvatarChange={changeAvatar} avatarError={avatarError} scheduleError={scheduleError} selectedWeek={currentWeekId} authenticated={Boolean(player)} profileCommand={profileCommand} onProfileCommandHandled={handleProfileCommandHandled} supportUrl={supportUrl} activeRegistration={activeRegistration} />}
      </div>
      <PlayerSupportChat player={player} lang={lang} theme={theme} />
      <footer className="legal-footer">{text.footer}</footer>

      <nav className={`bottom-nav${navHidden ? ' bottom-nav--hidden' : ''}`} role="tablist" aria-label={lang === 'ET' ? 'ዋና ማውጫ' : 'Main navigation'}>
        {tabs.map((tab) => (
          <button
            className={`nav-item${activeTab === tab.id ? ' nav-item--active' : ''}`}
            type="button"
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => navigate(tab.id)}
          >
            <Icon name={tab.icon} size={19} />
            <span>{text[{ home: 'home', tournament: 'tournamentTab', register: 'registerTab', profile: 'profileTab' }[tab.id]]}</span>
          </button>
        ))}
      </nav>
      {showLogin && (
        <LoginModal
          lang={lang}
          form={loginForm}
          mode={authMode}
          onChange={updateLoginForm}
          onModeChange={setAuthMode}
          onClose={() => setShowLogin(false)}
          onSubmit={signIn}
          error={authError}
          busy={authBusy}
        />
      )}
      {(isOffline || loading || authChecking) && (
        <LoadingScreen
          fullScreen
          offline={isOffline}
          language={lang}
          message={isOffline ? text.connecting : loadingMessage || text.loading}
          detail={isOffline ? text.connectionInterrupted : text.brandDetail}
        />
      )}
    </main>
  )
}

export default App
