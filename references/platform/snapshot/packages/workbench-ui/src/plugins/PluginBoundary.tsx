import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { Button } from "../components/ui";
interface Props {
  name: string;
  children: ReactNode;
}
/** Contains rendering errors. It does not isolate code, event handlers or permissions. */
export class PluginBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() {
    return this.state.failed ? (
      <div className="plugin-error" role="alert">
        <strong>{this.props.name}暂时无法显示</strong>
        <p>会话和其他页面仍可使用。</p>
        <Button onClick={() => this.setState({ failed: false })}>
          重试显示
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
