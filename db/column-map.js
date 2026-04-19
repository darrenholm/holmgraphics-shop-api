// db/column-map.js
// DEPRECATED — no longer used.
//
// When the backend ran against Azure SQL, the column names in the live DB
// didn't always match what the API code wanted, so routes went through this
// map (e.g. `C.Projects.id` → 'ProjectID'). During the Railway Postgres
// cutover the schema was normalized to snake_case names that the routes can
// use directly, so the indirection was removed.
//
// All route files were rewritten to hit snake_case columns directly. Nothing
// imports this file anymore. It's left in place as a breadcrumb; safe to
// delete once you're confident you won't need to consult the old mapping.

module.exports = {};
