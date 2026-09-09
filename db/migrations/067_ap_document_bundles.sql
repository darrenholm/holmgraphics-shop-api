-- One PDF holding several invoices.
--
-- Suppliers send month-end reprint bundles: Timbremart's August invoices
-- arrive as a single PDF of a dozen separate bills. Every part of this
-- pipeline assumed one file was one bill — content_sha256 is UNIQUE, so the
-- bundle could only ever become a single document, and eleven of the twelve
-- invoices were silently lost.
--
-- The bundle is now split into a child document per invoice, each carrying
-- its own pages so the right pages attach to the right bill in QuickBooks.
-- The original stays as the parent: it is the file that actually arrived, and
-- throwing it away would make the split impossible to check afterwards.

ALTER TABLE ap_documents
  ADD COLUMN IF NOT EXISTS parent_document_id INT REFERENCES ap_documents(id) ON DELETE SET NULL,
  -- 1-based, inclusive, into the parent's PDF.
  ADD COLUMN IF NOT EXISTS page_from INT,
  ADD COLUMN IF NOT EXISTS page_to   INT;

CREATE INDEX IF NOT EXISTS ap_documents_parent_idx
  ON ap_documents (parent_document_id)
  WHERE parent_document_id IS NOT NULL;
