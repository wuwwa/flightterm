import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '2rem',
          fontFamily: 'monospace',
          color: '#f87171',
          backgroundColor: '#0a0a0a',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
        }}>
          <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Something went wrong</h1>
          <pre style={{
            fontSize: '0.85rem',
            color: '#a1a1aa',
            maxWidth: '600px',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}>
            {this.state.error?.message || 'Unknown error'}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.5rem 1.5rem',
              background: '#27272a',
              color: '#e4e4e7',
              border: '1px solid #3f3f46',
              borderRadius: '4px',
              cursor: 'pointer',
              fontFamily: 'monospace',
            }}
          >
            Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
