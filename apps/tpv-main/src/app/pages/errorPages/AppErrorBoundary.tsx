import React from "react";
import ErrorFallback from "./ErrorFallback";

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
        // Aquí puedes loguear, o enviar a Rust, etc.
        console.error("💥 ErrorBoundary caught:", error, info);
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
