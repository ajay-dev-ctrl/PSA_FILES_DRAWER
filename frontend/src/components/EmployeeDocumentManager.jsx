import { REQUIREMENT_DOCUMENTS } from "../constants.js";

/**
 * The expanded body of a Document Status row: every requirement document by
 * full name, each one directly uploadable. Replaces the old separate
 * "Saved Users" card + document dropdown.
 */
export default function EmployeeDocumentManager({
  memoryId,
  uploadedFiles,
  onUpload,
  onView,
  onDownload,
  onDelete,
}) {
  return (
    <div className="doc-manager">
      {REQUIREMENT_DOCUMENTS.map((doc) => {
        const slot = uploadedFiles[doc.item] ?? {};
        const files = slot.files ?? [];
        const done = files.length > 0;
        const inputId = `file-${memoryId}-${doc.item}`;

        return (
          <div key={doc.item} className={`doc-row${done ? " doc-row--done" : ""}`}>
            <div className="doc-row__head">
              <span className="dash-doc-check" aria-hidden="true">
                {done ? (
                  <svg width="12" height="12" viewBox="0 0 16 16">
                    <path d="M3 8.5l3.2 3.2L13 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="4.6" stroke="currentColor" strokeWidth="1.6" fill="none" />
                  </svg>
                )}
              </span>

              <span className="doc-row__label">
                {doc.item}. {doc.name}
                {files.length > 1 && <span className="doc-row__count">{files.length} files</span>}
              </span>

              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
                id={inputId}
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUpload(memoryId, doc.item, f);
                  e.target.value = "";
                }}
              />
              {slot.uploading ? (
                <span className="file-uploading" style={{ whiteSpace: "nowrap" }}>
                  <span className="upload-spinner" /> Uploading…
                </span>
              ) : (
                <button
                  type="button"
                  className="doc-row__upload"
                  onClick={() => document.getElementById(inputId)?.click()}
                >
                  {done ? "Replace" : "Upload"}
                </button>
              )}
            </div>

            {slot.errMsg && (
              <div className="doc-row__error">⚠ Upload failed — {slot.errMsg}</div>
            )}

            {files.length > 0 && (
              <div className="doc-row__files">
                {files.map((f) => (
                  <div key={f.id} className="doc-file">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--psa-blue)" style={{ flexShrink: 0 }}>
                      <path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9h-4v4h-2v-4H9V9h4V5h2v4h4v2zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z" />
                    </svg>
                    <span className="doc-file__name">{f.filename}</span>
                    <span className="doc-file__kind">
                      {f.mimeType?.startsWith("image/") ? "Photo" : "PDF"}
                    </span>
                    <button
                      type="button"
                      className="doc-file__btn doc-file__btn--view"
                      title={`View ${f.filename}`}
                      aria-label={`View ${f.filename}`}
                      onClick={() => onView(memoryId, doc.item)}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="dl-btn"
                      title={`Download ${f.filename}`}
                      aria-label={`Download ${f.filename}`}
                      onClick={() => onDownload(memoryId, doc.item, f.id, f.filename)}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="doc-file__btn doc-file__btn--del"
                      title="Delete this file"
                      aria-label={`Delete ${f.filename}`}
                      onClick={() => onDelete(memoryId, doc.item, f.id, f.filename)}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
