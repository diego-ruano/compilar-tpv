import React from "react";
import ErrorFallback from "./ErrorFallback";
import { captureException } from "../../../shared/observability/sentry";

type Props = {
    children: React.ReactNode;
};

type State = {
    hasError: boolean;
    error?: unknown;
};

export default class AppErrorBoundary extends React.Component<Props, State> {
    state: State = { hasError: false, error: undefined };

    static getDerivedStateFromError(error: unknown): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: unknown, info: unknown) {
        // Reporta a Sentry (vía el SDK de Rust).
        captureException(error, { react: info });
    }

    reset = () => {
        this.setState({ hasError: false, error: undefined });
    };

    render() {
        if (this.state.hasError) {
            return (
                <ErrorFallback
                    error={this.state.error}
                    resetError={this.reset}
                />
            );
        }

        return this.props.children;
    }
}
