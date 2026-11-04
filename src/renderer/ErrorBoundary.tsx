import React from 'react';

interface ErrorBoundaryState { error?: Error }

/** A renderer exception must not leave a blank window with no recovery path. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Renderer crashed', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return <div className="fatal-error" role="alert">
      <div>
        <div className="eyebrow">RENDERER ERROR</div>
        <h1>界面遇到未处理的错误</h1>
        <p>会话数据仍在本地。重新加载即可恢复工作台；如果问题反复出现，请把下面的错误信息发回给我们。</p>
        <pre>{this.state.error.message}</pre>
        <button className="button primary" onClick={() => window.location.reload()}>重新加载</button>
      </div>
    </div>;
  }
}
