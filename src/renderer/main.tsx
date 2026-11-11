import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles/app.css';
import './styles/workbench.css';

const theme = {
  token: {
    colorPrimary: '#2563eb',
    colorInfo: '#2563eb',
    colorSuccess: '#16a34a',
    colorWarning: '#d97706',
    colorError: '#dc2626',
    colorText: '#0f172a',
    colorTextSecondary: '#475569',
    colorBorder: '#dbe3ef',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    borderRadius: 8,
    borderRadiusSM: 6,
    controlHeight: 34,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif',
  },
  components: {
    Button: { controlHeight: 32, fontWeight: 500 },
    Segmented: { itemSelectedBg: '#eff6ff', itemSelectedColor: '#1d4ed8' },
    Tabs: { itemColor: '#64748b', itemSelectedColor: '#1d4ed8', inkBarColor: '#2563eb' },
  },
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider theme={theme}>
      <ErrorBoundary><App /></ErrorBoundary>
    </ConfigProvider>
  </React.StrictMode>,
);
