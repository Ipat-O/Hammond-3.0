const boundaryCards = [
  {
    label: 'Local workspace',
    description: 'Native filesystem commands will stay behind a typed command surface.',
  },
  {
    label: 'Project memory',
    description: 'Supabase access will be introduced through an isolated data boundary.',
  },
  {
    label: 'Local settings',
    description: 'Operating-system settings remain separate from durable project records.',
  },
];

function App() {
  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Application navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            H
          </span>
          <span className="brand-name">Hammond</span>
        </div>

        <nav className="primary-nav" aria-label="Primary">
          <a className="nav-item nav-item-active" href="#workspace" aria-current="page">
            <span className="nav-icon" aria-hidden="true">
              ◈
            </span>
            Workspace
          </a>
          <a className="nav-item nav-item-muted" href="#settings">
            <span className="nav-icon" aria-hidden="true">
              ⚙
            </span>
            Settings
          </a>
        </nav>

        <div className="sidebar-footer">
          <span className="status-dot" aria-hidden="true" />
          Desktop shell ready
        </div>
      </aside>

      <section className="content-area" id="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Desktop application foundation</p>
            <h1>Good morning, owner.</h1>
          </div>
          <span className="version-pill">v0.1.0</span>
        </header>

        <div className="content-grid">
          <section className="welcome-card" aria-labelledby="welcome-heading">
            <div className="welcome-copy">
              <p className="card-kicker">Hammond is ready</p>
              <h2 id="welcome-heading">A calm place for project context.</h2>
              <p>
                The desktop shell is connected to a native Tauri runtime. Project, task, and
                delivery workflows will arrive in the next foundation slices.
              </p>
            </div>
            <div className="welcome-orbit" aria-hidden="true">
              <span className="orbit-ring orbit-ring-large" />
              <span className="orbit-ring orbit-ring-small" />
              <span className="orbit-core">H</span>
            </div>
          </section>

          <section className="boundary-section" aria-labelledby="boundary-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Foundation map</p>
                <h2 id="boundary-heading">Clear boundaries, ready to extend.</h2>
              </div>
              <span className="section-count">03 modules</span>
            </div>

            <div className="boundary-grid">
              {boundaryCards.map((card, index) => (
                <article className="boundary-card" key={card.label}>
                  <span className="boundary-index">0{index + 1}</span>
                  <h3>{card.label}</h3>
                  <p>{card.description}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

export default App;
