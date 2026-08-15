import { useCallback, useEffect, useMemo, useState } from "react";
import { REQUIREMENT_DOCUMENTS } from "../constants.js";
import { TOTAL_DOCS, useDocumentStatusRows } from "../components/DocumentStatusTable.jsx";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const ATTENTION_LIMIT = 8;
const TOP_DOCS_SHOWN = 8;
const STALE_LIMIT = 8;
const RECENT_LIMIT = 8;
/** No upload in this long means the record has gone quiet, not that it is done. */
const STALE_DAYS = 90;

const DOC_NAME_BY_ITEM = new Map(REQUIREMENT_DOCUMENTS.map((d) => [d.item, d.name]));

function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function daysSince(date) {
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function timeAgo(date) {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(days / 365)}y ago`;
}

/**
 * Completion spread. Says whether the shortfall is a long tail of near-done
 * records or a block of people with nothing on file — which the headline
 * percentage alone cannot distinguish.
 */
const COMPLETION_BUCKETS = [
  { key: "none", label: "Nothing on file", match: (c) => c === 0 },
  { key: "1-4", label: "1–4 documents", match: (c) => c >= 1 && c <= 4 },
  { key: "5-8", label: "5–8 documents", match: (c) => c >= 5 && c <= 8 },
  { key: "9-12", label: "9–12 documents", match: (c) => c >= 9 && c <= 12 },
  {
    key: "13-near",
    label: `13–${TOTAL_DOCS - 1} documents`,
    match: (c) => c >= 13 && c < TOTAL_DOCS,
  },
  { key: "all", label: `All ${TOTAL_DOCS}`, match: (c) => c >= TOTAL_DOCS },
];

/** Latest uploads agency-wide. Separate from the summary payload — it changes far more often. */
function useRecentUploads() {
  const [uploads, setUploads] = useState([]);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/dashboard/recent?limit=${RECENT_LIMIT}`, {
        credentials: "include",
      });
      if (r.status === 401) { window.location.replace("/login.html"); return; }
      if (!r.ok) throw new Error("Could not load recent activity.");
      const data = await r.json();
      setUploads(data.map((u) => ({ ...u, uploadedAt: new Date(u.uploaded_at) })));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { uploads, error };
}

/** Uploads per month for the trend chart. Zero-filled server-side. */
function useUploadTrend() {
  const [trend, setTrend] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiUrl}/dashboard/trend?months=6`, { credentials: "include" });
        if (r.status === 401) { window.location.replace("/login.html"); return; }
        if (!r.ok) return;
        setTrend(await r.json());
      } catch { /* the chart is decorative enough to fail quietly */ }
    })();
  }, []);

  return trend;
}

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function monthLabel(ym) {
  const m = Number(String(ym).slice(5, 7));
  return MONTH_LABELS[m - 1] ?? ym;
}

/**
 * Smooth filled area chart, hand-rolled in SVG so the dashboard picks up no
 * charting dependency. Catmull-Rom control points give the soft curve without
 * overshooting into negative counts.
 */
function AreaChart({ points, width = 620, height = 190 }) {
  const padL = 30;
  const padR = 8;
  const padT = 12;
  const padB = 26;

  if (points.length < 2) {
    return <div className="empty">Not enough history to chart yet.</div>;
  }

  const peak = Math.max(...points.map((p) => p.uploads), 1);
  // Round the axis up to something readable rather than the raw peak.
  const step = peak <= 5 ? 1 : peak <= 20 ? 5 : 10;
  const top = Math.ceil(peak / step) * step;

  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const x = (i) => padL + (innerW * i) / (points.length - 1);
  const y = (v) => padT + innerH - (innerH * v) / top;

  const coords = points.map((p, i) => [x(i), y(p.uploads)]);

  let line = `M ${coords[0][0]} ${coords[0][1]}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x0, y0] = coords[Math.max(i - 1, 0)];
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[i + 1];
    const [x3, y3] = coords[Math.min(i + 2, coords.length - 1)];
    const c1x = x1 + (x2 - x0) / 6;
    const c1y = y1 + (y2 - y0) / 6;
    const c2x = x2 - (x3 - x1) / 6;
    const c2y = y2 - (y3 - y1) / 6;
    line += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
  }
  const area = `${line} L ${coords[coords.length - 1][0]} ${y(0)} L ${coords[0][0]} ${y(0)} Z`;

  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);

  return (
    <svg
      className="area-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Documents uploaded per month: ${points
        .map((p) => `${monthLabel(p.month)} ${p.uploads}`)
        .join(", ")}`}
    >
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2f5d9e" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#2f5d9e" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {ticks.map((v) => (
        <g key={v}>
          <line
            className="area-grid"
            x1={padL} y1={y(v)} x2={width - padR} y2={y(v)}
          />
          <text className="area-axis" x={padL - 8} y={y(v) + 3.5} textAnchor="end">
            {v}
          </text>
        </g>
      ))}

      <path d={area} fill="url(#areaFill)" />
      <path d={line} className="area-line" />

      {coords.map(([cx, cy], i) => (
        <circle key={points[i].month} cx={cx} cy={cy} r="3.4" className="area-dot">
          <title>{`${monthLabel(points[i].month)}: ${points[i].uploads} uploaded`}</title>
        </circle>
      ))}

      {points.map((p, i) => (
        <text
          key={p.month}
          className="area-axis"
          x={x(i)}
          y={height - 8}
          textAnchor="middle"
        >
          {monthLabel(p.month)}
        </text>
      ))}
    </svg>
  );
}

/**
 * Donut of how the roster splits by completeness. Segments are drawn with
 * stroke-dasharray on one circle — no path maths, no library.
 */
function Donut({ segments, centerValue, centerLabel }) {
  const R = 54;
  const CIRC = 2 * Math.PI * R;
  const total = segments.reduce((s, x) => s + x.value, 0);

  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = total > 0 ? (s.value / total) * CIRC : 0;
      const arc = { ...s, len, offset };
      offset += len;
      return arc;
    });

  return (
    <div className="donut-wrap">
      <div className="donut">
        <svg viewBox="0 0 140 140" role="img" aria-label={centerLabel}>
          <circle className="donut-track" cx="70" cy="70" r={R} strokeWidth="18" fill="none" />
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx="70" cy="70" r={R}
              fill="none"
              stroke={a.color}
              strokeWidth="18"
              strokeDasharray={`${a.len} ${CIRC - a.len}`}
              strokeDashoffset={-a.offset}
              // Start the first segment at 12 o'clock instead of 3.
              transform="rotate(-90 70 70)"
            >
              <title>{`${a.label}: ${a.value}`}</title>
            </circle>
          ))}
        </svg>
        <div className="donut-center">
          <div className="donut-center__value">{centerValue}</div>
          <div className="donut-center__label">{centerLabel}</div>
        </div>
      </div>

      <div className="donut-legend">
        {segments.map((s) => (
          <div className="donut-legend__item" key={s.key}>
            <div className="donut-legend__pct">{pct(s.value, total)}%</div>
            <div className="donut-legend__name">
              <span className="donut-legend__dot" style={{ background: s.color }} />
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A ranked horizontal bar. One hue — the number is a magnitude, not a status,
 * so red/green stay reserved for actual state.
 */
function RankBar({ name, value, suffix, ratio, soft, onClick, active, title }) {
  const body = (
    <>
      <div className="rank-label">
        <span className="rank-name">{name}</span>
        <span className="rank-val">
          {value}
          {suffix ? <small> {suffix}</small> : null}
        </span>
      </div>
      <div className="rank-track">
        <div
          className={`rank-fill${soft ? " rank-fill--soft" : ""}`}
          style={{ width: `${Math.max(ratio, 0)}%` }}
        />
      </div>
    </>
  );

  if (!onClick) return <div className="rank-row">{body}</div>;

  return (
    <button
      type="button"
      className={`rank-row rank-row--clickable${active ? " rank-row--active" : ""}`}
      aria-pressed={active}
      title={title}
      onClick={onClick}
    >
      {body}
    </button>
  );
}

function PageHeader({ children }) {
  return (
    <div className="page-header dash-header">
      <div>
        <div className="page-header-title">Dashboard</div>
        <div className="page-header-sub">Where the agency stands on document compliance</div>
      </div>
      {children}
    </div>
  );
}

export default function Dashboard({ onOpenInAddFiles }) {
  const { rows, loading, error } = useDocumentStatusRows();
  const { uploads, error: recentError } = useRecentUploads();
  const trend = useUploadTrend();
  const [showAllDocs, setShowAllDocs] = useState(false);
  // Separated staff should not drag completion down, so Active leads.
  const [scope, setScope] = useState("active");
  const [officeFilter, setOfficeFilter] = useState(null);

  const scopedRows = useMemo(
    () => (scope === "active" ? rows.filter((r) => r.recordStatus === "Active") : rows),
    [rows, scope]
  );

  const separatedCount = rows.length - rows.filter((r) => r.recordStatus === "Active").length;

  const stats = useMemo(() => {
    const total = scopedRows.length;
    const required = total * TOTAL_DOCS;
    const onFile = scopedRows.reduce((sum, r) => sum + r.completedCount, 0);
    return {
      total,
      complete: scopedRows.filter((r) => r.pct >= 100).length,
      required,
      onFile,
      missing: required - onFile,
      compliance: pct(onFile, required),
    };
  }, [scopedRows]);

  // Three-way split for the donut: done / started / not started.
  const donutSegments = useMemo(() => {
    const complete = scopedRows.filter((r) => r.completedCount >= TOTAL_DOCS).length;
    const none = scopedRows.filter((r) => r.completedCount === 0).length;
    // Same three status colours the progress bars already use — no new hues.
    return [
      { key: "complete", label: "Complete", value: complete, color: "#2e7d46" },
      {
        key: "partial",
        label: "In progress",
        value: scopedRows.length - complete - none,
        color: "#d9930b",
      },
      { key: "none", label: "Nothing on file", value: none, color: "#c0392b" },
    ];
  }, [scopedRows]);

  // How many people are missing each requirement — the view that says what to
  // ask for next, rather than who to chase.
  const missingByDoc = useMemo(() => {
    if (scopedRows.length === 0) return [];
    return REQUIREMENT_DOCUMENTS
      .map((d) => ({
        item: d.item,
        name: `${d.item}. ${d.name}`,
        missing: scopedRows.filter((r) => !r.completedSet.has(d.item)).length,
      }))
      .filter((d) => d.missing > 0)
      .sort((a, b) => b.missing - a.missing || a.item.localeCompare(b.item));
  }, [scopedRows]);

  const byOffice = useMemo(() => {
    const map = new Map();
    for (const r of scopedRows) {
      const key = r.officeDivision || "unknown";
      const entry = map.get(key) ?? { office: key, people: 0, onFile: 0 };
      entry.people += 1;
      entry.onFile += r.completedCount;
      map.set(key, entry);
    }
    return Array.from(map.values())
      .map((e) => ({ ...e, compliance: pct(e.onFile, e.people * TOTAL_DOCS) }))
      .sort((a, b) => a.compliance - b.compliance || a.office.localeCompare(b.office));
  }, [scopedRows]);

  // Permanent vs Casual vs COS behave differently on paperwork; the agency-wide
  // percentage hides that.
  const byEmploymentStatus = useMemo(() => {
    const map = new Map();
    for (const r of scopedRows) {
      const key = r.employmentStatus || "Unspecified";
      const entry = map.get(key) ?? { status: key, people: 0, onFile: 0 };
      entry.people += 1;
      entry.onFile += r.completedCount;
      map.set(key, entry);
    }
    return Array.from(map.values())
      .map((e) => ({ ...e, compliance: pct(e.onFile, e.people * TOTAL_DOCS) }))
      .sort((a, b) => a.compliance - b.compliance || a.status.localeCompare(b.status));
  }, [scopedRows]);

  const distribution = useMemo(
    () =>
      COMPLETION_BUCKETS.map((b) => ({
        ...b,
        people: scopedRows.filter((r) => b.match(r.completedCount)).length,
      })),
    [scopedRows]
  );

  const incomplete = useMemo(
    () =>
      [...scopedRows]
        .filter((r) => r.pct < 100)
        .sort((a, b) => a.completedCount - b.completedCount || a.name.localeCompare(b.name)),
    [scopedRows]
  );

  const needsAttention = useMemo(() => {
    const list = officeFilter
      ? incomplete.filter((r) => r.officeDivision === officeFilter)
      : incomplete;
    return list.slice(0, ATTENTION_LIMIT);
  }, [incomplete, officeFilter]);

  // Never-uploaded records sort first: they are staler than any dated one.
  const stale = useMemo(
    () =>
      scopedRows
        .filter((r) => r.pct < 100 && (!r.lastUploadAt || daysSince(r.lastUploadAt) >= STALE_DAYS))
        .sort((a, b) => {
          if (!a.lastUploadAt && !b.lastUploadAt) return a.name.localeCompare(b.name);
          if (!a.lastUploadAt) return -1;
          if (!b.lastUploadAt) return 1;
          return a.lastUploadAt - b.lastUploadAt;
        })
        .slice(0, STALE_LIMIT),
    [scopedRows]
  );

  const visibleDocs = showAllDocs ? missingByDoc : missingByDoc.slice(0, TOP_DOCS_SHOWN);
  const maxBucket = Math.max(...distribution.map((b) => b.people), 1);

  if (loading) {
    return (
      <>
        <PageHeader />
        <div className="empty">Loading…</div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader />
        <div className="empty">{error}</div>
      </>
    );
  }

  return (
    <>
      <PageHeader>
        <div className="dash-controls">
          <div className="scope-toggle" role="group" aria-label="Which employees to count">
            <button
              type="button"
              className={`scope-btn${scope === "active" ? " scope-btn--on" : ""}`}
              aria-pressed={scope === "active"}
              onClick={() => setScope("active")}
            >
              Active only
            </button>
            <button
              type="button"
              className={`scope-btn${scope === "all" ? " scope-btn--on" : ""}`}
              aria-pressed={scope === "all"}
              onClick={() => setScope("all")}
            >
              All records
            </button>
          </div>
        </div>
      </PageHeader>

      {scope === "active" && separatedCount > 0 && (
        <div className="dash-scope-note">
          Excluding {separatedCount} separated {separatedCount === 1 ? "record" : "records"}{" "}
          (resigned, retired or transferred).
        </div>
      )}

      {/* ── Hero: headline figures + upload trend, donut alongside ── */}
      <div className="hero-grid">
        <section className="panel hero-panel">
          <div className="hero-body">
            <div className="hero-figures">
              <div className="hero-eyebrow">Overview</div>
              <div className="hero-sub">Document compliance</div>

              <div className="hero-value">{stats.compliance}%</div>
              <div className="hero-caption">
                {stats.onFile} of {stats.required} documents on file
              </div>

              <div className="hero-value hero-value--sm">{stats.total}</div>
              <div className="hero-caption">
                {scope === "active" ? "Active employees" : "Employee records"}
              </div>
            </div>

            <div className="hero-chart">
              <div className="hero-chart__head">
                <span className="chart-legend">
                  <span className="chart-legend__dot" />
                  Documents uploaded
                </span>
                <span className="panel-meta">last 6 months</span>
              </div>
              <AreaChart points={trend} />
            </div>
          </div>

          {/* KPI strip — secondary counts, subordinate to the figures above */}
          <div className="kpi-strip">
            <div className="kpi">
              <span className="kpi__icon" aria-hidden="true">◆</span>
              <div>
                <div className="kpi__label">Incomplete</div>
                <div className="kpi__value">{incomplete.length}</div>
              </div>
            </div>
            <div className="kpi">
              <span className="kpi__icon" aria-hidden="true">●</span>
              <div>
                <div className="kpi__label">Documents missing</div>
                <div className="kpi__value">{stats.missing}</div>
              </div>
            </div>
            <div className="kpi">
              <span className="kpi__icon" aria-hidden="true">▲</span>
              <div>
                <div className="kpi__label">Offices</div>
                <div className="kpi__value">{byOffice.length}</div>
              </div>
            </div>
            <div className="kpi">
              <span className="kpi__icon" aria-hidden="true">■</span>
              <div>
                <div className="kpi__label">Gone quiet</div>
                <div className="kpi__value">{stale.length}</div>
              </div>
            </div>
          </div>
        </section>

        <section className="panel donut-panel">
          <div className="section-heading">
            <h3 className="panel-title">
              <span className="panel-title-dot" />
              Roster split
            </h3>
          </div>
          {stats.total === 0 ? (
            <div className="empty">No employees yet.</div>
          ) : (
            <Donut
              segments={donutSegments}
              centerValue={`${stats.compliance}%`}
              centerLabel="compliant"
            />
          )}
        </section>
      </div>

      {/* ── Headline numbers ── */}
      <div className="stat-row">
        <div className="grad-tile grad-tile--d1">
          <div className="grad-tile__label">Employees</div>
          <div className="grad-tile__value">{stats.total}</div>
          <div className="grad-tile__foot">
            {scope === "active" ? "active records" : "all records"}
          </div>
        </div>
        <div className="grad-tile grad-tile--d2">
          <div className="grad-tile__label">Documents on file</div>
          <div className="grad-tile__value">{stats.onFile}</div>
          <div className="grad-tile__foot">of {stats.required} required</div>
        </div>
        <div className="grad-tile grad-tile--d3">
          <div className="grad-tile__label">Fully complete</div>
          <div className="grad-tile__value">{stats.complete}</div>
          <div className="grad-tile__foot">
            {stats.complete === 0 ? `nobody reaches ${TOTAL_DOCS}/${TOTAL_DOCS}` : `of ${stats.total} employees`}
          </div>
        </div>
        <div className="grad-tile grad-tile--d4">
          <div className="grad-tile__label">Documents missing</div>
          <div className="grad-tile__value">{stats.missing}</div>
          <div className="grad-tile__foot">across {incomplete.length} people</div>
        </div>
      </div>

      {/* ── Which document is missing for the most people ── */}
      <section className="panel">
        <div className="section-heading">
          <h3 className="panel-title">
            <span className="panel-title-dot" />
            Most-missing documents
          </h3>
          <span className="panel-meta">of {stats.total} employees</span>
        </div>

        {missingByDoc.length === 0 ? (
          <div className="empty">Every requirement is on file for everyone.</div>
        ) : (
          <>
            <div className="rank-bars">
              {visibleDocs.map((d) => (
                <RankBar
                  key={d.item}
                  name={d.name}
                  value={d.missing}
                  suffix={`/ ${stats.total}`}
                  ratio={pct(d.missing, stats.total)}
                  soft={d.missing < stats.total}
                />
              ))}
            </div>
            {missingByDoc.length > TOP_DOCS_SHOWN && (
              <button
                type="button"
                className="ghost-button rank-more"
                onClick={() => setShowAllDocs((v) => !v)}
              >
                {showAllDocs
                  ? "Show top 8"
                  : `Show all ${missingByDoc.length} with gaps`}
              </button>
            )}
          </>
        )}
      </section>

      {/* ── Where to chase ── */}
      <div className="dash-split">
        <section className="panel">
          <div className="section-heading">
            <h3 className="panel-title">
              <span className="panel-title-dot" />
              By office / division
            </h3>
            <span className="panel-meta">click to filter</span>
          </div>
          {byOffice.length === 0 ? (
            <div className="empty">No employees yet.</div>
          ) : (
            <div className="rank-bars">
              {byOffice.map((o) => (
                <RankBar
                  key={o.office}
                  name={`${o.office} · ${o.people} ${o.people === 1 ? "person" : "people"}`}
                  value={`${o.compliance}%`}
                  ratio={o.compliance}
                  active={officeFilter === o.office}
                  title={
                    officeFilter === o.office
                      ? "Clear the filter"
                      : `Show only ${o.office} in Needs attention`
                  }
                  onClick={() =>
                    setOfficeFilter((cur) => (cur === o.office ? null : o.office))
                  }
                />
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-heading">
            <h3 className="panel-title">
              <span className="panel-title-dot" />
              Needs attention
            </h3>
            <span className="panel-meta">fewest documents first</span>
          </div>

          {officeFilter && (
            <button
              type="button"
              className="dash-filter-chip"
              title="Clear office filter"
              onClick={() => setOfficeFilter(null)}
            >
              {officeFilter} <span aria-hidden="true">×</span>
            </button>
          )}

          {needsAttention.length === 0 ? (
            <div className="empty">
              {officeFilter
                ? `Nobody in ${officeFilter} is missing anything.`
                : "Nobody is missing anything."}
            </div>
          ) : (
            <div className="att-list">
              {needsAttention.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`att-row${r.completedCount === 0 ? " att-row--zero" : ""}`}
                  title={`Open ${r.name} in Employees`}
                  onClick={() => onOpenInAddFiles?.(r.id, r.name)}
                >
                  <span className="att-name">{r.name}</span>
                  <span className="att-office">{r.officeDivision}</span>
                  <span className={`att-count${r.completedCount === 0 ? " att-count--zero" : ""}`}>
                    {r.completedCount}/{TOTAL_DOCS}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ── How the shortfall is shaped ── */}
      <div className="dash-split">
        <section className="panel">
          <div className="section-heading">
            <h3 className="panel-title">
              <span className="panel-title-dot" />
              By employment status
            </h3>
          </div>
          {byEmploymentStatus.length === 0 ? (
            <div className="empty">No employees yet.</div>
          ) : (
            <div className="rank-bars">
              {byEmploymentStatus.map((s) => (
                <RankBar
                  key={s.status}
                  name={`${s.status} · ${s.people} ${s.people === 1 ? "person" : "people"}`}
                  value={`${s.compliance}%`}
                  ratio={s.compliance}
                />
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-heading">
            <h3 className="panel-title">
              <span className="panel-title-dot" />
              Completion spread
            </h3>
            <span className="panel-meta">people per band</span>
          </div>
          {stats.total === 0 ? (
            <div className="empty">No employees yet.</div>
          ) : (
            <div className="rank-bars">
              {distribution.map((b) => (
                <RankBar
                  key={b.key}
                  name={b.label}
                  value={b.people}
                  suffix={b.people === 1 ? "person" : "people"}
                  ratio={pct(b.people, maxBucket)}
                  soft={b.key !== "all"}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ── Movement ── */}
      <div className="dash-split">
        <section className="panel">
          <div className="section-heading">
            <h3 className="panel-title">
              <span className="panel-title-dot" />
              Recent activity
            </h3>
            <span className="panel-meta">latest uploads</span>
          </div>
          {recentError ? (
            <div className="empty">{recentError}</div>
          ) : uploads.length === 0 ? (
            <div className="empty">No documents have been uploaded yet.</div>
          ) : (
            <div className="att-list">
              {uploads.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="att-row"
                  title={`Open ${u.employee_name ?? "this employee"} at document ${u.doc_item}`}
                  onClick={() =>
                    onOpenInAddFiles?.(u.memory_id, u.employee_name ?? "", u.doc_item)
                  }
                >
                  <span className="att-name">{u.employee_name || "Unnamed user"}</span>
                  <span className="att-office">
                    {u.doc_item}. {DOC_NAME_BY_ITEM.get(u.doc_item) ?? u.filename}
                  </span>
                  <span className="att-count att-count--muted">{timeAgo(u.uploadedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-heading">
            <h3 className="panel-title">
              <span className="panel-title-dot" />
              Gone quiet
            </h3>
            <span className="panel-meta">no upload in {STALE_DAYS}+ days</span>
          </div>
          {stale.length === 0 ? (
            <div className="empty">Every incomplete record has moved recently.</div>
          ) : (
            <div className="att-list">
              {stale.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`att-row${r.lastUploadAt ? "" : " att-row--zero"}`}
                  title={`Open ${r.name} in Employees`}
                  onClick={() => onOpenInAddFiles?.(r.id, r.name)}
                >
                  <span className="att-name">{r.name}</span>
                  <span className="att-office">{r.completedCount}/{TOTAL_DOCS} on file</span>
                  <span className="att-count att-count--muted">
                    {r.lastUploadAt ? timeAgo(r.lastUploadAt) : "never"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
