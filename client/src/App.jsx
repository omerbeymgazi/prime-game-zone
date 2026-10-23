import { useEffect, useState } from 'react'
import './App.css'
import AdminDashboard from './components/AdminDashboard.jsx'
import LoadingScreen from './components/LoadingScreen.jsx'

const API_BASE = `${(import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')}/api`

const tournament = {
  name: 'Prime Ethiopia Cup',
  games: 'FIFA 26 & FIFA 27',
  platforms: 'PS4 / PS5',
  format: '1v1 Knockout',
  slots: 32,
  remaining: 14,
  entryFee: '1,500 ETB',
  prizePool: '10,000 ETB',
}

const prizes = [
  { place: '1st', medal: '🥇', amount: '10,000', className: 'gold' },
  { place: '2nd', medal: '🥈', amount: '8,000', className: 'silver' },
  { place: '3rd', medal: '🥉', amount: '5,000', className: 'bronze' },
  { place: '4th', medal: '🏅', amount: '1,500', className: 'fourth' },
]

const payments = [
  { id: 'telebirr', name: 'Telebirr', mark: 'T', image: '/Telebirr.png', detail: 'Mobile money' },
  { id: 'cbe', name: 'Commercial Bank of Ethiopia', shortName: 'CBE', mark: 'C', image: '/commercial-bank-of-ethiopia-logo-png_seeklogo-547506.png', detail: 'Bank transfer' },
  { id: 'abyssinia', name: 'Bank of Abyssinia', shortName: 'BOA', mark: 'A', image: '/abyssinia.jpg', detail: 'Bank transfer' },
  { id: 'awash', name: 'Awash Bank', shortName: 'AWB', mark: 'A', image: '/Awash-Bank-removebg-preview.png', detail: 'Bank transfer' },
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
    localProfile: 'Preview only: account services are not connected. Do not use a real password.',
    noAccount: "Don't have an account? Register",
    haveAccount: 'Already registered? Login',
    forgotPassword: 'Forgot Password? Contact Support',
    supportContact: 'Open Telegram to contact the tournament organizer.',
    home: 'Home',
    tournamentTab: 'Tournament',
    registerTab: 'Register',
    profileTab: 'Profile',
    telegramStatus: 'TELEGRAM PLAYER',
    localStatus: 'LOCAL PROFILE',
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
    prizePool: '10,000 ETB prize pool',
    entryFee: 'Entry Fee',
    register: 'Register for',
    firstPlace: '1st Place',
    secondPlace: '2nd Place',
    thirdPlace: '3rd Place',
    fourthPlace: '4th Place',
    champion: 'CHAMPION',
    runnerUp: 'RUNNER-UP',
    thirdAward: '3RD PLACE',
    fourthAward: '4TH PLACE',
    place: 'PLACE',
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
    contactLabel: 'Phone Number or PSN ID',
    contactPlaceholder: '+251 9XX XXX XXX or PSN ID',
    fullNameLabel: 'Full Name / Player Name',
    phonePlaceholder: '+251 9XX XXX XXX',
    contactSummary: 'Phone / PSN',
    paymentMethod: 'Choose payment method',
    paymentLabel: 'Payment method',
    mobileMoney: 'Mobile money',
    bankTransfer: 'Bank transfer',
    inPersonPayment: 'In-person payment',
    paymentDisclaimer: 'Secure your slot after the organizer confirms your payment. No payment is collected in this app.',
    receiptUpload: 'Upload payment receipt (optional)',
    receiptInvalid: 'Choose a PNG, JPG, or WebP receipt under 5 MB.',
    scheduleLoadError: 'Live tournament availability is temporarily unavailable.',
    proceedPayment: 'Proceed to Payment & Confirm Registration',
    savedRegistration: 'Registration request saved.',
    followUp: 'Follow up with the tournament organizer to complete payment and confirm your slot.',
    profileHub: 'PLAYER HUB',
    matchCenter: 'Your match center.',
    profileDescription: 'Player identity, registration and the road to the final.',
    telegramPlayer: 'TELEGRAM PLAYER',
    localPreview: 'LOCAL PROFILE PREVIEW',
    primePlayer: 'PRIME GAMING PLAYER',
    psnNotConnected: 'PSN ID not connected',
    online: 'ONLINE',
    player: 'PLAYER',
    profileSettings: 'Profile settings',
    uploadAvatar: 'Upload profile picture',
    weeklySchedule: 'Weekly Tournament Schedule',
    selectWeek: 'Choose an upcoming tournament week',
    week: 'Week',
    tournament: 'Tournament',
    slotsLeftOf: 'Slots Left / 32 Total',
    weekNameOne: 'Week 1: Prime Clash',
    weekNameTwo: 'Week 2: Mid-Month Showdown',
    weekNameThree: 'Week 3: Ethiopia Elite Series',
    weekNameFour: 'Week 4: Final Whistle Cup',
    spotsFilled: 'Spots Filled',
    spotsRemaining: 'Spots Remaining',
    weekCardHint: 'Tap to view rules & register',
    weekDetails: 'Tournament details',
    registerWeek: 'Register Now for',
    registrationWeek: 'Selected tournament',
    halfTimeRule: '4-minute halves',
    kickoffRule: 'Kick-off mode',
    formationsRule: 'Custom formations allowed',
    weekOpen: 'OPEN',
    weekFull: 'FULL',
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
    contactSupport: 'Contact tournament support',
    supportDescription: 'Message the official Prime Gaming organizer on Telegram for help with registration or payment.',
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
    localProfile: 'ቅድመ እይታ ብቻ፦ የመለያ አገልግሎት አልተገናኘም። እውነተኛ የይለፍ ቃል አያስገቡ።',
    noAccount: 'መለያ የለዎትም? ይመዝገቡ',
    haveAccount: 'አስቀድመው ተመዝግበዋል? ይግቡ',
    forgotPassword: 'የይለፍ ቃል ረሱ? ድጋፍን ያግኙ',
    supportContact: 'የውድድሩን አዘጋጅ ለማግኘት ቴሌግራምን ይክፈቱ።',
    home: 'መነሻ',
    tournamentTab: 'ውድድር',
    registerTab: 'ምዝገባ',
    profileTab: 'መገለጫ',
    telegramStatus: 'የቴሌግራም ተጫዋች',
    localStatus: 'የአካባቢ መገለጫ',
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
    prizeBreakdown: 'የሽልማት መጠን',
    prizePool: '10,000 ETB ጠቅላላ ሽልማት',
    entryFee: 'የመግቢያ ክፍያ',
    register: 'ለመመዝገብ',
    firstPlace: '1ኛ ደረጃ',
    secondPlace: '2ኛ ደረጃ',
    thirdPlace: '3ኛ ደረጃ',
    fourthPlace: '4ኛ ደረጃ',
    champion: 'አሸናፊ',
    runnerUp: 'ምክትል',
    thirdAward: 'ነሐስ',
    fourthAward: 'ልዩ ሽልማት',
    place: 'ደረጃ',
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
    contactLabel: 'ስልክ ቁጥር ወይም PSN መለያ',
    contactPlaceholder: '+251 9XX XXX XXX ወይም PSN መለያ',
    fullNameLabel: 'ሙሉ ስም / የተጫዋች ስም',
    phonePlaceholder: '+251 9XX XXX XXX',
    contactSummary: 'ስልክ / PSN',
    paymentMethod: 'የክፍያ መንገድ ይምረጡ',
    paymentLabel: 'የክፍያ መንገድ',
    mobileMoney: 'የሞባይል ገንዘብ',
    bankTransfer: 'የባንክ ሂሳብ ማስተላለፍ',
    inPersonPayment: 'በአካል ክፍያ',
    paymentDisclaimer: 'አዘጋጁ ክፍያዎን ካረጋገጠ በኋላ ቦታዎ ይጠበቃል። በዚህ መተግበሪያ ክፍያ አይሰበሰብም።',
    receiptUpload: 'የክፍያ ደረሰኝ ይጫኑ (አማራጭ)',
    receiptInvalid: 'ከ5 MB በታች PNG፣ JPG ወይም WebP ደረሰኝ ይምረጡ።',
    scheduleLoadError: 'የውድድር ቦታ መረጃ ለጊዜው አይገኝም።',
    proceedPayment: 'ወደ ክፍያ ይቀጥሉ እና ምዝገባን ያረጋግጡ',
    savedRegistration: 'የምዝገባ ጥያቄ ተቀምጧል።',
    followUp: 'ክፍያውን ለመጨረስ እና ቦታዎን ለማረጋገጥ የውድድሩን አዘጋጅ ያነጋግሩ።',
    profileHub: 'የተጫዋች ማዕከል',
    matchCenter: 'የጨዋታ ማዕከልዎ።',
    profileDescription: 'የተጫዋች መረጃ፣ ምዝገባ እና ወደ ፍጻሜው የሚወስድ መንገድ።',
    telegramPlayer: 'የቴሌግራም ተጫዋች',
    localPreview: 'የአካባቢ መገለጫ ቅድመ እይታ',
    primePlayer: 'ፕራይም ጌሚንግ ተጫዋች',
    psnNotConnected: 'PSN መለያ አልተገናኘም',
    online: 'በመስመር ላይ',
    player: 'ተጫዋች',
    profileSettings: 'የመገለጫ ቅንብሮች',
    uploadAvatar: 'የመገለጫ ፎቶ ይጫኑ',
    weeklySchedule: 'የሳምንታዊ ውድድር መርሐግብር',
    selectWeek: 'ከሚቀጥሉት ሳምንታት ውድድር ይምረጡ',
    week: 'ሳምንት',
    tournament: 'ውድድር',
    slotsLeftOf: 'ቦታዎች ቀርተዋል / 32 ጠቅላላ',
    weekNameOne: 'ሳምንት 1፦ Prime Clash',
    weekNameTwo: 'ሳምንት 2፦ Mid-Month Showdown',
    weekNameThree: 'ሳምንት 3፦ Ethiopia Elite Series',
    weekNameFour: 'ሳምንት 4፦ Final Whistle Cup',
    spotsFilled: 'ቦታዎች ተይዘዋል',
    spotsRemaining: 'ቦታዎች ቀርተዋል',
    weekCardHint: 'ህጎችን እና ምዝገባን ለማየት ይጫኑ',
    weekDetails: 'የውድድር ዝርዝሮች',
    registerWeek: 'አሁን ይመዝገቡ፦',
    registrationWeek: 'የተመረጠው ውድድር',
    halfTimeRule: '4 ደቂቃ አጋማሾች',
    kickoffRule: 'Kick-off ሁነታ',
    formationsRule: 'ብጁ አሰላለፍ ይፈቀዳል',
    weekOpen: 'ክፍት',
    weekFull: 'ሙሉ',
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
    contactSupport: 'የውድድር ድጋፍን ያግኙ',
    supportDescription: 'ስለ ምዝገባ ወይም ክፍያ እገዛ ለማግኘት በቴሌግራም የፕራይም ጌሚንግ አዘጋጅን ያነጋግሩ።',
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

function getWeeklySchedule() {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const remainingSlots = [8, 18, 12, 24]
  const nameKeys = ['weekNameOne', 'weekNameTwo', 'weekNameThree', 'weekNameFour']
  const themes = ['gold', 'cyan', 'purple', 'emerald']
  const formatDate = (date) => new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date)

  return remainingSlots.map((remaining, index) => {
    const start = new Date(monthStart.getFullYear(), monthStart.getMonth(), index * 7 + 1)
    const end = new Date(monthStart.getFullYear(), monthStart.getMonth(), index * 7 + 7)
    return {
      id: index,
      nameKey: nameKeys[index],
      theme: themes[index],
      dateRange: `${formatDate(start)} - ${formatDate(end)}`,
      capacity: 32,
      filled: 32 - remaining,
      remaining,
      status: 'open',
    }
  })
}

function Header({ lang, onLanguageChange, player, avatar, onHome, onLogin, onProfile }) {
  const text = translations[lang]
  const initials = player?.displayName?.trim()?.slice(0, 1)?.toUpperCase() || player?.name?.trim()?.slice(0, 1)?.toUpperCase() || 'P'

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
              {language}
            </button>
          ))}
        </div>
        {player ? (
          <button className="header-player" type="button" onClick={onProfile} aria-label={`Open player profile for ${player.psnId || player.displayName || player.name}`}>
            <span className="header-avatar">{avatar ? <img src={avatar} alt="" /> : initials}</span>
            <span className="header-player-copy">
              <strong>{player.psnId || player.displayName || player.name}</strong>
              <small><i /> {player.source === 'telegram' ? text.telegramStatus : text.localStatus}</small>
            </span>
          </button>
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

function HomeTab({ onNavigate, lang }) {
  const text = translations[lang]
  const filledPercent = ((tournament.slots - tournament.remaining) / tournament.slots) * 100
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
        <span className="ticker-copy"><small>{text.tickerOpen}</small><strong>{text.cup} <span>🏆</span></strong></span>
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

      <section className="slots-card" aria-label={`${tournament.remaining} of ${tournament.slots} tournament slots remaining`}>
        <div className="slots-heading">
          <span className="slots-icon"><Icon name="users" size={18} /></span>
          <span><small>{text.capacity}</small><strong>{tournament.remaining} <i>/ {tournament.slots}</i> {text.slotsRemaining}</strong></span>
          <span className="slots-open"><i /> {text.open}</span>
        </div>
        <div
          className="slots-track"
          role="progressbar"
          aria-label={text.capacity}
          aria-valuemin="0"
          aria-valuemax={tournament.slots}
          aria-valuenow={tournament.slots - tournament.remaining}
        >
          <span style={{ width: `${filledPercent}%` }} />
        </div>
        <div className="slots-foot"><span>14 / 32 {text.slotsRemaining}</span><button type="button" onClick={() => onNavigate('register')}>{text.claimSpot} <Icon name="arrow" size={14} /></button></div>
      </section>
    </section>
  )
}

function TournamentTab({ onRegister, lang }) {
  const text = translations[lang]
  const [showRules, setShowRules] = useState(false)

  return (
    <section className="tab-panel detail-tab" aria-labelledby="tournament-title">
      <div className="detail-hero">
        <div className="detail-texture" aria-hidden="true"><span>FC 27</span><span>HYPERMOTION</span><span>FC 26</span></div>
        <span className="hero-kicker"><i /> {text.registrationOpen}</span>
        <SoccerBallArt />
        <h1 id="tournament-title">{lang === 'ET' ? text.cup : <>Prime Ethiopia<br /><span>Cup</span></>}</h1>
        <p className="detail-games">{tournament.games} <i>·</i> {tournament.platforms}</p>
        <div className="detail-tags"><span><Icon name="gamepad" size={14} /> {text.knockoutFormat}</span><span><Icon name="users" size={14} /> {tournament.slots} {text.slots}</span></div>
        <div className="detail-fee"><span>{text.entryFee}</span><strong>{tournament.entryFee}</strong></div>
      </div>

      <section className="section-block">
        <SectionHeading kicker={lang === 'ET' ? 'ለዋንጫው ይወዳደሩ' : 'COMPETE FOR THE TOP'} title={text.prizeBreakdown} action={<span className="pool-chip">{text.prizePool}</span>} />
        <div className="prize-grid">
          {prizes.map((prize, index) => (
            <article className={`prize-card prize-${prize.className}`} key={prize.place}>
              <div className="prize-card-top">
                <span className="prize-rank"><span className="prize-medal" aria-hidden="true">{prize.medal}</span><span>#{index + 1}</span></span>
                <span className={`prize-status${index === 0 ? ' champion-badge' : ''}`}>{text[['champion', 'runnerUp', 'thirdAward', 'fourthAward'][index]]}</span>
              </div>
              <strong className="prize-amount"><span>{prize.amount}</span><small>ETB</small></strong>
              <span className="prize-place">{text[`${['first', 'second', 'third', 'fourth'][index]}Place`]}</span>
            </article>
          ))}
        </div>
      </section>

      <button className="rules-accordion rules-trigger" type="button" onClick={() => setShowRules(true)}>
        <span className="rules-summary-icon"><Icon name="shield" size={18} /></span>
        <span className="rules-trigger-copy"><small>{text.info}</small><strong>{text.rules}</strong></span>
        <span className="rules-more-label">{text.seeRules}</span>
        <Icon name="chevron" size={18} />
      </button>

      <div className="detail-slots">
        <span><Icon name="users" size={17} /> {tournament.remaining} / {tournament.slots} {text.slotsLeft}</span>
        <span className="detail-live"><i /> {text.open}</span>
      </div>
      <button className="primary-button full-button" type="button" onClick={onRegister}>
        {text.register} {tournament.entryFee} <Icon name="arrow" size={17} />
      </button>
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
    <div className="rules-backdrop" onMouseDown={(event) => {
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
    </div>
  )
}

function RegistrationTab({ form, onChange, onSubmit, submitted, submitting, submitError, receiptName, onReceiptChange, lang, selectedWeek }) {
  const text = translations[lang]
  const selectedSchedule = getWeeklySchedule()[selectedWeek]
  return (
    <section className="tab-panel register-tab" aria-labelledby="register-title">
      <div className="page-intro">
        <span className="eyebrow">{text.introKicker}</span>
        <h1 id="register-title">{text.introTitle}</h1>
        <p>{text.introDescription}</p>
      </div>

      <div className="registration-banner">
        <span className="banner-icon"><Icon name="ticket" size={20} /></span>
        <span><small>{text.entryBanner}</small><strong>{tournament.entryFee}</strong></span>
        <span className="banner-platform">PS4 / PS5</span>
      </div>
      <p className="registration-week-selection"><Icon name="calendar" size={15} /><span>{text.registrationWeek}: <strong>{text[selectedSchedule.nameKey]}</strong> · {selectedSchedule.dateRange}</span></p>

      <form className="registration-form" onSubmit={onSubmit}>
        <div className="form-section-title"><span>01</span><strong>{text.playerDetails}</strong></div>
        <label className="field-label" htmlFor="player-name">{text.fullNameLabel}</label>
        <input id="player-name" name="playerName" value={form.playerName} onChange={onChange} placeholder={text.playerNamePlaceholder} autoComplete="name" maxLength={60} required />

        <label className="field-label" htmlFor="player-contact">{text.contactLabel}</label>
        <input id="player-contact" name="contact" value={form.contact} onChange={onChange} placeholder={text.contactPlaceholder} autoComplete="off" maxLength={64} required />

        <label className="receipt-upload" htmlFor="payment-receipt">
          <Icon name="ticket" size={17} />
          <span>{receiptName || text.receiptUpload}</span>
          <input id="payment-receipt" type="file" accept="image/png,image/jpeg,image/webp" onChange={onReceiptChange} />
        </label>

        <div className="form-section-title payment-title"><span>02</span><strong>{text.paymentMethod}</strong></div>
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
        <button className="primary-button full-button payment-submit" type="submit" disabled={submitting}>
          {submitting ? (lang === 'ET' ? 'በማስቀመጥ ላይ...' : 'Saving registration…') : text.proceedPayment} {!submitting && <Icon name="arrow" size={17} />}
        </button>
        {submitError && <p className="registration-error" role="alert">{submitError}</p>}
        {submitted && (
          <p className="form-success" role="status"><Icon name="check" size={18} /><span><strong>{text.savedRegistration}</strong> {text.followUp}</span></p>
        )}
      </form>
    </section>
  )
}

function TournamentWeekModal({ week, text, onClose, onRegister }) {
  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="week-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className={`week-modal week-modal--${week.theme}`} role="dialog" aria-modal="true" aria-labelledby="week-modal-title">
        <button className="rules-modal-close" type="button" onClick={onClose} aria-label={text.close}><Icon name="close" size={20} /></button>
        <span className="week-modal-kicker"><Icon name="trophy" size={16} /> {text.weekDetails}</span>
        <h2 id="week-modal-title">{text[week.nameKey]}</h2>
        <p className="week-modal-date">{week.dateRange}</p>
        <div className="week-modal-spots"><Icon name="users" size={17} /><strong>{week.remaining} {text.spotsRemaining}</strong><span>{week.filled} / 32 {text.spotsFilled}</span></div>
        <div className="week-modal-hours">
          <span className="weekly-hours-icon"><Icon name="clock" size={18} /></span>
          <span><strong>{text.dailyHours}</strong><b>{text.scheduleHours}</b><small>{text.matchesPerDay}</small></span>
        </div>
        <div className="week-modal-rules">
          <h3>{text.rulesTitle}</h3>
          <p>{text.halfTimeRule} <i>·</i> {text.kickoffRule} <i>·</i> {text.formationsRule}</p>
        </div>
        <div className="anti-gambling-notice">
          <strong>{text.strictPolicy}</strong>
          <p>{text.antiGambling}</p>
        </div>
        <button className="primary-button full-button week-register-button" type="button" disabled={week.status !== 'open' || week.remaining < 1} onClick={() => onRegister(week.id)}>
          {week.status === 'open' && week.remaining > 0 ? <>{text.registerWeek} {text.week} {week.id + 1} <Icon name="arrow" size={17} /></> : text.registrationClosed}
        </button>
      </section>
    </div>
  )
}

function ProfileTab({ registration, player, onRegister, onLogout, lang, avatar, onAvatarChange, avatarError, selectedWeek }) {
  const text = translations[lang]
  const [schedule, setSchedule] = useState(getWeeklySchedule())
  const [scheduleError, setScheduleError] = useState('')
  const [activeWeek, setActiveWeek] = useState(null)
  const telegramUser = window.Telegram?.WebApp?.initDataUnsafe?.user
  const displayName = player?.displayName || registration?.playerName || telegramUser?.first_name || telegramUser?.username || text.player
  const psnId = player?.psnId
  const initials = displayName.trim().slice(0, 1).toUpperCase()

  useEffect(() => {
    let active = true
    fetch(`${API_BASE}/tournaments/weeks`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `Tournament availability request failed (${response.status}).`)
        return data
      })
      .then((data) => {
        if (!active) return
        setSchedule(data.weeks.map((week) => ({
          id: week.weekId,
          nameKey: ['weekNameOne', 'weekNameTwo', 'weekNameThree', 'weekNameFour'][week.weekId],
          theme: week.theme,
          dateRange: week.dateRange,
          remaining: week.availableSlots,
          filled: week.capacity - week.availableSlots,
          status: week.status,
        })))
        setScheduleError('')
      })
      .catch((error) => {
        if (!active) return
        setScheduleError(`${text.scheduleLoadError} ${error.message}`)
      })
    return () => { active = false }
  }, [text.scheduleLoadError])

  return (
    <section className="tab-panel profile-tab" aria-labelledby="profile-title">
      <div className="page-intro">
        <span className="eyebrow">{text.profileHub}</span>
        <h1 id="profile-title">{text.matchCenter}</h1>
        <p>{text.profileDescription}</p>
      </div>

      <article className="player-card">
        <div className="player-card-glow" aria-hidden="true" />
        <div className="player-avatar">{avatar ? <img src={avatar} alt="" /> : initials}</div>
        <div className="player-identity"><small>{player?.source === 'telegram' ? text.telegramPlayer : player ? text.localPreview : text.primePlayer}</small><h2>{displayName}</h2><p><Icon name="gamepad" size={14} /> {psnId || (registration ? `${text.contactSummary}: ${registration.contact}` : text.psnNotConnected)}</p>{player?.psCode && <p className="player-ps-code">{text.generatedPsCode}: {player.psCode}</p>}</div>
        <span className="psn-badge"><i>PS</i> {player ? text.online : text.player}</span>
        {player?.source === 'local' && <button className="profile-signout" type="button" onClick={onLogout}>{text.signOut}</button>}
      </article>

      <section className="profile-settings" aria-labelledby="profile-settings-title">
        <h2 id="profile-settings-title">{text.profileSettings}</h2>
        <label className="avatar-upload">
          <Icon name="user" size={18} />
          <span>{text.uploadAvatar}</span>
          <input type="file" accept="image/*" onChange={onAvatarChange} />
        </label>
        {avatarError && <p className="avatar-error" role="alert">{avatarError}</p>}
      </section>

      <section className="section-block weekly-schedule" aria-label={text.weeklySchedule}>
        <SectionHeading kicker={text.selectWeek} title={text.weeklySchedule} />
        <div className="weekly-options">
          {schedule.map((week) => (
            <button
              className={`weekly-option weekly-option--${week.theme}${selectedWeek === week.id ? ' weekly-option--selected' : ''}`}
              type="button"
              key={week.id}
              aria-pressed={selectedWeek === week.id}
              aria-haspopup="dialog"
              onClick={() => setActiveWeek(week)}
            >
              <span className="weekly-option-heading">{text[week.nameKey]}</span>
              <strong className="weekly-option-date">{week.dateRange}</strong>
              <span className="weekly-capacity-copy">{week.filled}/32 {text.spotsFilled} <b>·</b> {week.remaining} {text.spotsRemaining}</span>
              <span className="weekly-capacity-track" role="progressbar" aria-label={`${week.filled}/32 ${text.spotsFilled}`} aria-valuemin={0} aria-valuemax={32} aria-valuenow={week.filled}><i style={{ '--week-capacity': `${(week.filled / 32) * 100}%` }} /></span>
              {week.status !== 'open' && <span className={`weekly-status weekly-status--${week.status}`}>{text[week.status === 'full' ? 'weekFull' : 'weekCompleted']}</span>}
              <span className="weekly-card-hint">{text.weekCardHint}<Icon name="chevron" size={14} /></span>
            </button>
          ))}
        </div>
        {scheduleError && <p className="schedule-error" role="status">{scheduleError}</p>}
        {registration && <p className="registered-week">{text.registeredWeek}: {text.week} {registration.weekId + 1} · {schedule[registration.weekId].dateRange}</p>}
        <div className="weekly-match-hours">
          <span className="weekly-hours-icon"><Icon name="clock" size={18} /></span>
          <span><strong>{text.dailyHours}</strong><b>{text.scheduleHours}</b><small>{text.matchesPerDay}</small></span>
        </div>
      </section>

      <section className="section-block">
        <SectionHeading kicker={text.competition} title={text.registeredTournaments} />
        {registration ? (
          <article className="registered-card">
            <span className="registered-icon"><Icon name="trophy" size={19} /></span>
            <span className="registered-copy"><small>{text.cup}</small><strong>{registration.playerName}</strong><span>{text.contactSummary} · {registration.contact}</span></span>
            <span className="pending-badge"><i /> {text.paymentPending}</span>
          </article>
        ) : (
          <div className="empty-state"><span className="empty-icon"><Icon name="ticket" size={21} /></span><strong>{text.noRegistrations}</strong><span>{text.nextCompetition}</span><button type="button" onClick={onRegister}>{text.exploreRegistration} <Icon name="arrow" size={15} /></button></div>
        )}
      </section>

      <section className="section-block bracket-section">
        <SectionHeading kicker={text.roadToCup} title={text.matchBracket} />
        <div className="bracket-card">
          <div className="bracket-header"><span><Icon name="bracket" size={17} /> {text.knockout}</span><small>{text.preview}</small></div>
          <div className="bracket-rounds">
            <div className="bracket-round"><small>{lang === 'ET' ? 'የ32ኛው ዙር' : 'ROUND OF 32'}</small><span className="bracket-player">{psnId || text.yourPsn}<i>{lang === 'ET' ? 'እርስዎ' : 'YOU'}</i></span><span className="bracket-player">{text.opponent} <i>{lang === 'ET' ? 'አልታወቀም' : 'TBD'}</i></span></div>
            <span className="bracket-connector" aria-hidden="true" />
            <div className="bracket-round bracket-round--later"><small>{lang === 'ET' ? 'የ16ኛው ዙር' : 'ROUND OF 16'}</small><span className="bracket-player">{text.winnerR32}<i>{lang === 'ET' ? 'አልታወቀም' : 'TBD'}</i></span><span className="bracket-player">{text.opponent}<i>{lang === 'ET' ? 'አልታወቀም' : 'TBD'}</i></span></div>
          </div>
          <p>{text.matchupNotice}</p>
        </div>
      </section>

      <section className="support-card">
        <span className="support-icon"><Icon name="support" size={20} /></span>
        <span><small>{text.needHelp}</small><strong>{text.contactSupport}</strong><p>{text.supportDescription}</p></span>
      </section>
      {activeWeek && <TournamentWeekModal week={activeWeek} text={text} onClose={() => setActiveWeek(null)} onRegister={(weekId) => {
        setActiveWeek(null)
        onRegister(weekId)
      }} />}
    </section>
  )
}

function LoginModal({ lang, mode, form, onChange, onModeChange, onClose, onSubmit }) {
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
    <div className="login-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <button className="login-close" type="button" onClick={onClose} aria-label={text.close}><Icon name="close" size={18} /></button>
        <span className="login-modal-icon"><Icon name="login" size={21} /></span>
        <span className="eyebrow">{text.profileHub}</span>
        <h2 id="login-title">{isRegister ? text.registerAccount : text.signIn}</h2>
        <p className="login-note">{text.localProfile}</p>
        <form onSubmit={onSubmit}>
          <label htmlFor="auth-phone">{text.phone}</label>
          <input id="auth-phone" name="phone" type="tel" value={form.phone} onChange={onChange} autoComplete="tel" inputMode="tel" placeholder={text.phonePlaceholder} required />
          <label htmlFor="auth-password">{text.password}</label>
          <input id="auth-password" name="password" type="password" value={form.password} onChange={onChange} autoComplete={isRegister ? 'new-password' : 'current-password'} minLength="8" required />
          {isRegister && <>
            <label htmlFor="auth-telegram">{text.telegramUsername}</label>
            <input id="auth-telegram" name="telegramUsername" value={form.telegramUsername} onChange={onChange} autoComplete="off" placeholder="@username" pattern="@?[A-Za-z0-9_]{5,32}" required />
          </>}
          <button className="primary-button full-button" type="submit"><Icon name="login" size={16} /> {isRegister ? text.createAccount : text.continue}</button>
        </form>
        <nav className="auth-links" aria-label={text.profileHub}>
          {isRegister
            ? <button type="button" onClick={() => onModeChange('login')}>{text.haveAccount}</button>
            : <button type="button" onClick={() => onModeChange('register')}>{text.noAccount}</button>}
          <a href="https://t.me/" target="_blank" rel="noreferrer">{text.forgotPassword}</a>
        </nav>
        <p className="auth-support-note">{text.supportContact}</p>
      </section>
    </div>
  )
}

function App({ loading = false, authChecking = false, loadingMessage }) {
  const [activeTab, setActiveTab] = useState('home')
  const [navHidden, setNavHidden] = useState(false)
  const [lang, setLang] = useState('EN')
  const [showLogin, setShowLogin] = useState(false)
  const [authMode, setAuthMode] = useState('login')
  const [loginForm, setLoginForm] = useState({ phone: '', password: '', telegramUsername: '' })
  const [avatar, setAvatar] = useState('')
  const [avatarError, setAvatarError] = useState('')
  const [player, setPlayer] = useState(() => {
    const telegramUser = window.Telegram?.WebApp?.initDataUnsafe?.user
    return telegramUser
      ? { displayName: telegramUser.first_name || telegramUser.username || 'Player', psnId: '', source: 'telegram' }
      : null
  })
  const [isOffline, setIsOffline] = useState(() => !navigator.onLine)
  const [form, setForm] = useState({ playerName: '', contact: '', payment: '' })
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

  function updateLoginForm(event) {
    const { name, value } = event.target
    setLoginForm((current) => ({ ...current, [name]: value }))
  }

  function signIn(event) {
    event.preventDefault()
    const telegramUsername = loginForm.telegramUsername.trim().replace(/^@/, '')
    const psCode = authMode === 'register'
      ? `PS-${crypto.randomUUID().toUpperCase()}`
      : undefined
    setPlayer({
      displayName: telegramUsername || 'Prime Player',
      phone: loginForm.phone.trim(),
      telegramUsername,
      psCode,
      source: 'local',
    })
    setLoginForm({ phone: '', password: '', telegramUsername: '' })
    setShowLogin(false)
  }

  function changeAvatar(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
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
    const reader = new FileReader()
    reader.onload = () => setAvatar(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => setAvatarError(lang === 'ET' ? 'ምስሉን ማንበብ አልተቻለም። እንደገና ይሞክሩ።' : 'Could not read the image. Please try again.')
    reader.readAsDataURL(file)
  }

  function updateForm(event) {
    setSubmitted(false)
    setRegistrationError('')
    const { name, value } = event.target
    setForm((current) => ({ ...current, [name]: value }))
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
    setReceiptError('')
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setReceiptData(reader.result)
        setReceiptName(file.name)
      } else {
        setReceiptError(lang === 'ET' ? 'ደረሰኙን ማንበብ አልተቻለም።' : 'The receipt image could not be read.')
      }
    }
    reader.onerror = () => setReceiptError(lang === 'ET' ? 'ደረሰኙን ማንበብ አልተቻለም።' : 'The receipt image could not be read.')
    reader.readAsDataURL(file)
  }

  async function register(event) {
    event.preventDefault()
    setSubmittingRegistration(true)
    setRegistrationError('')
    try {
      const response = await fetch(`${API_BASE}/registrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerName: form.playerName.trim(),
          contact: form.contact.trim(),
          payment: form.payment,
          weekId: selectedWeek,
          receiptData,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Registration request failed (${response.status}).`)
      setRegistration({ ...data.registration, weekId: selectedWeek, payment: form.payment, contact: form.contact.trim(), playerName: form.playerName.trim() })
      setSubmitted(true)
    } catch (error) {
      setRegistrationError(error.message)
    } finally {
      setSubmittingRegistration(false)
    }
  }

  if (window.location.pathname.replace(/\/+$/, '') === '/admin') {
    return <AdminDashboard />
  }

  return (
    <main className="app-shell" lang={lang === 'ET' ? 'am' : 'en'}>
      <div className="field-overlay" aria-hidden="true" />
      <div className="ambient-glow ambient-glow--one" aria-hidden="true" />
      <div className="ambient-glow ambient-glow--two" aria-hidden="true" />
      <Header
        lang={lang}
        onLanguageChange={setLang}
        player={player}
        avatar={avatar}
        onHome={() => navigate('home')}
        onLogin={() => {
          setAuthMode('login')
          setShowLogin(true)
        }}
        onProfile={() => navigate('profile')}
      />

      <div className="page-content" key={activeTab}>
        {activeTab === 'home' && <HomeTab onNavigate={navigate} lang={lang} />}
        {activeTab === 'tournament' && <TournamentTab onRegister={() => navigate('register')} lang={lang} />}
        {activeTab === 'register' && <RegistrationTab form={form} onChange={updateForm} onSubmit={register} submitted={submitted} submitting={submittingRegistration} submitError={receiptError || registrationError} receiptName={receiptName} onReceiptChange={changeReceipt} lang={lang} selectedWeek={selectedWeek} />}
        {activeTab === 'profile' && <ProfileTab registration={registration} player={player} onRegister={(weekId) => {
          setSelectedWeek(weekId ?? selectedWeek)
          navigate('register')
        }} onLogout={() => setPlayer(null)} lang={lang} avatar={avatar} onAvatarChange={changeAvatar} avatarError={avatarError} selectedWeek={selectedWeek} />}
      </div>
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
