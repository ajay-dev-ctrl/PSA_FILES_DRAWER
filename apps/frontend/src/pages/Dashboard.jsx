import { useEffect, useMemo, useState } from "react";
import { REQUIREMENT_DOCUMENTS } from "../constants.js";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const TOTAL_DOCS = REQUIREMENT_DOCUMENTS.length;

function progressBand(pct) {
  if (pct >= 70) return "high";
  if (pct >= 30) return "partial";
  return "low";
}

function CompleteBadge() {
  return (
    <span className="dash-complete-badge">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2e7d46" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      All complete
    </span>
  );
}

export default function Dashboard({ onOpenInAddFiles }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [officeFilter, setOfficeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  function toggleExpanded(id) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiUrl}/dashboard/summary`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("Could not load dashboard data.");
        return r.json();
      })
      .then((rows) => { if (!cancelled) setEmployees(rows); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => employees.map((e) => {
    const completedSet = new Set(e.completed_items ?? []);
    const completedCount = REQUIREMENT_DOCUMENTS.filter((d) => completedSet.has(d.item)).length;
    return {
      id: e.id,
      name: e.name || "Unnamed user",
      position: e.position || "No position",
      officeDivision: e.office_division || "unknown",
      completedSet,
      completedCount,
      pct: TOTAL_DOCS ? Math.round((completedCount / TOTAL_DOCS) * 100) : 0,
    };
  }), [employees]);

  const officeOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.officeDivision));
    return Array.from(set).sort();
  }, [rows]);

  // Table shows everyone matching office/status — employee selection doesn't narrow it.
  const filteredRows = rows.filter((r) => {
    if (officeFilter && r.officeDivision !== officeFilter) return false;
    if (statusFilter === "complete" && r.pct < 100) return false;
    if (statusFilter === "incomplete" && r.pct >= 100) return false;
    return true;
  });

  const employeeOptions = useMemo(() => {
    return [...filteredRows].sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredRows]);

  // Keep the picker pointed at someone valid as data/filters change.
  useEffect(() => {
    if (employeeOptions.length === 0) { setEmployeeFilter(""); return; }
    if (!employeeOptions.some((r) => r.id === employeeFilter)) {
      setEmployeeFilter(employeeOptions[0].id);
    }
  }, [employeeOptions, employeeFilter]);

  const selectedEmployee = employeeOptions.find((r) => r.id === employeeFilter) ?? null;

  return (
    <>
      <div className="page-header">
        <div className="page-header-title">Dashboard</div>
        <div className="page-header-sub">Document completion overview per employee</div>
      </div>

      {/* ── Filters + Employee Overview, combined into one panel ── */}
      <section className="panel" id="dashboard-filters">
        <div className="section-heading">
          <h3 className="panel-title">
            <span className="panel-title-dot" />
            Filters
          </h3>
        </div>
        <div className="dash-filter-row">
          <label>
            Office / Division
            <select value={officeFilter} onChange={(e) => setOfficeFilter(e.target.value)}>
              <option value="">All offices</option>
              {officeOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label>
            Completion status
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="complete">Complete</option>
              <option value="incomplete">Incomplete</option>
            </select>
          </label>
          <label>
            Employee
            <select value={employeeFilter} onChange={(e) => setEmployeeFilter(e.target.value)}>
              {employeeOptions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        </div>

        <div className="data-column" style={{ marginTop: 16 }}>
          {loading ? (
            <div className="empty">Loading…</div>
          ) : error ? (
            <div className="empty">{error}</div>
          ) : !selectedEmployee ? (
            <div className="empty">No employees match the current filters.</div>
          ) : (() => {
            const r = selectedEmployee;
            const isExpanded = expandedIds.has(r.id);
            const missing = REQUIREMENT_DOCUMENTS.filter((d) => !r.completedSet.has(d.item));
            return (
              <article className="job-card">
                <div className="job-card__header" style={{ flexWrap: "wrap", gap: "10px 18px" }}>
                  <div className="job-card__info">
                    <button
                      type="button"
                      className="job-card__name dash-name-link"
                      title="Open in Add Files to attach documents"
                      onClick={() => onOpenInAddFiles?.(r.id, r.name)}
                    >
                      {r.name}
                    </button>
                    <div className="job-card__tags">
                      <span className="job-card__tag">{r.position}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div className="dash-summary-count">{r.completedCount}/{TOTAL_DOCS} documents</div>
                    <button
                      type="button"
                      className={`dash-expand-toggle${isExpanded ? " dash-expand-toggle--open" : ""}`}
                      aria-expanded={isExpanded}
                      title={isExpanded ? "Hide details" : "Show details"}
                      onClick={() => toggleExpanded(r.id)}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16">
                        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="dash-progress-track">
                  <div
                    className={`dash-progress-fill dash-progress-fill--${progressBand(r.pct)}`}
                    style={{ width: `${r.pct}%` }}
                  />
                </div>
                {isExpanded && (
                  <div className="dash-card-details">
                    <div className="dash-card-detail-row">
                      <span className="dash-card-detail-label">Office / Division</span>
                      <span>{r.officeDivision}</span>
                    </div>
                    <div className="dash-card-detail-row">
                      <span className="dash-card-detail-label">Missing Documents</span>
                      <span className="dash-missing-cell">
                        {missing.length === 0 ? (
                          <CompleteBadge />
                        ) : (
                          missing.map((d) => (
                            <span key={d.item} className="dash-missing-chip" title={d.name}>
                              {d.item}
                            </span>
                          ))
                        )}
                      </span>
                    </div>
                  </div>
                )}
              </article>
            );
          })()}
        </div>
      </section>

      {/* ── Document status table ── */}
      <section className="panel" id="dashboard-table">
        <div className="section-heading">
          <h3 className="panel-title">
            <span className="panel-title-dot" />
            Document Status
          </h3>
        </div>
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Office / Division</th>
                <th>Progress</th>
                <th>Missing Documents</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const missing = REQUIREMENT_DOCUMENTS.filter((d) => !r.completedSet.has(d.item));
                return (
                  <tr key={r.id}>
                    <td>
                      <button
                        type="button"
                        className="dash-name-link"
                        title="Open in Add Files to attach documents"
                        onClick={() => onOpenInAddFiles?.(r.id, r.name)}
                      >
                        {r.name}
                      </button>
                    </td>
                    <td>{r.officeDivision}</td>
                    <td>{r.completedCount}/{TOTAL_DOCS}</td>
                    <td className="dash-missing-cell">
                      {missing.length === 0 ? (
                        <CompleteBadge />
                      ) : (
                        missing.map((d) => (
                          <span key={d.item} className="dash-missing-chip" title={d.name}>
                            {d.item}
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
