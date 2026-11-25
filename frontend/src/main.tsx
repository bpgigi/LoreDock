import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: {
      colorPrimary: '#303b46', colorText: '#20252b', colorTextSecondary: '#69727d',
      colorBorder: '#e2e6ea', colorBgContainer: '#ffffff', borderRadius: 10,
      controlHeight: 40, fontSize: 14,
      colorInfo: '#6c86ad', colorSuccess: '#598574', colorWarning: '#a78048', colorError: '#ae6161',
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
    } }}><App /></ConfigProvider>
  </StrictMode>,
)
