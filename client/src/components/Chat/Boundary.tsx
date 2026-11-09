import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

type BoundaryProps = {
  /** Diagnostic name of the contained part. */
  name: string;
  /** Inputs the part renders from; any change retries a failed part. */
  resetKeys: readonly unknown[];
  fallback?: ReactNode;
  children: ReactNode;
};

type BoundaryState = {
  failed: boolean;
  keys: readonly unknown[];
};

const sameKeys = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/**
 * Contains a failure (render or effect) of an auxiliary chat part. Without it the error
 * reaches the route error boundary, which replaces and later remounts the whole signed-in
 * shell: the screen goes blank until authentication has bootstrapped again. The failed
 * part stays hidden until one of its `resetKeys` changes, then it is retried.
 */
export default class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, keys: this.props.resetKeys };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    if (sameKeys(state.keys, props.resetKeys)) {
      return null;
    }
    return { failed: false, keys: props.resetKeys };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[Boundary] ${this.props.name} failed and was hidden`, error, info);
  }

  render() {
    if (this.state.failed) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
