import './LoadingScreen.css'

function LoadingScreen({
  message,
  detail,
  language = 'EN',
  fullScreen = false,
  offline = false,
}) {
  const text = language === 'ET'
    ? {
        message: 'የጨዋታ መረጃ በመጫን ላይ...',
        detail: 'ፕራይም ጌሚንግ · ኢትዮጵያ',
        waiting: 'ግንኙነትዎ እስኪመለስ በመጠባበቅ ላይ…',
      }
    : {
        message: 'Loading Match Data...',
        detail: 'PREPARING YOUR NEXT MATCH',
        waiting: 'Waiting for your connection to return…',
      }

  return (
    <div
      className={`loading-screen${fullScreen ? ' loading-screen--fullscreen' : ''}${offline ? ' loading-screen--offline' : ''}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="loading-content">
        <div className="loading-emblem" aria-hidden="true">
          <span className="loading-orbit loading-orbit--outer" />
          <span className="loading-orbit loading-orbit--inner" />
          <img src="/ball.png" alt="" />
          <span className="loading-spark loading-spark--one" />
          <span className="loading-spark loading-spark--two" />
          <span className="loading-spark loading-spark--three" />
        </div>
        <p className="loading-detail">{detail || text.detail}</p>
        <h2 className="loading-message">{message || text.message}</h2>
        <div className="loading-progress" aria-hidden="true"><span /></div>
        {offline && <p className="loading-hint">{text.waiting}</p>}
      </div>
    </div>
  )
}

export default LoadingScreen
