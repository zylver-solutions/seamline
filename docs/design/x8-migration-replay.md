# X8: references at migration replay order

Status: design proposal for X8 migration replay, subordinate to v3 and `real-world-inputs.md` section 5.5, row H2. This document adds no implementation, evaluation label, successful acceptance or release claim. It leaves the original X7 acceptance unchanged.

## Admission and consumer

[SafeStepsApp PR57](https://github.com/kmwstudy88-ship-it/SafeStepsApp/pull/57) was merged on 2026-08-10. The upstream description identifies a clean rebuild ordering defect: the foreign key is deferred until its target exists. It explicitly distinguishes the already existing production constraint. The fix commit has one parent:

| Pin | Commit | Tree |
| --- | --- | --- |
| Parent | `76506eaa966121ab74ac1faf964cf7df75bd07ee` | `a4b00f763186a64323e4ce54a910687f22b8ff07` |
| Fix | `5f2e6aa9648f1d52ed9f38d253e61aeeb0128f4e` | `5dfff709d65ee5445293efd428077e430c83c50f` |

The parent [declares the child feedback table](https://github.com/kmwstudy88-ship-it/SafeStepsApp/blob/76506eaa966121ab74ac1faf964cf7df75bd07ee/supabase/migrations/20260721174116_ai_continuous_learning_volume10_completion.sql#L101-L106) with a foreign key to `public.children` at line 104. The first visible declaration of [the target table](https://github.com/kmwstudy88-ship-it/SafeStepsApp/blob/76506eaa966121ab74ac1faf964cf7df75bd07ee/supabase/migrations/202607220012_family_foundation_schema.sql#L75) sorts later. The fix removes the early foreign key and adds a [guarded restoration](https://github.com/kmwstudy88-ship-it/SafeStepsApp/blob/5f2e6aa9648f1d52ed9f38d253e61aeeb0128f4e/supabase/migrations/20260810120637_restore_ai_child_feedback_foreign_key.sql#L1-L18). Its table-existence guards and referenced column must be examined, not skipped to obtain a negative.

This merged repair supplies leg 1 for a reference to a table declared later in the migration history. It admits neither arbitrary database execution nor a claim about the state of a running production database. The named owner and window are the operator's accepted commitment (see the named-owner row of [real-world-inputs.md](real-world-inputs.md)): three triage passes after implementation merge or first public release, whichever is later. Both exact pins are development inputs. Their measured findings must be triaged before implementation merge. This design's merge supplies leg 3; successful implementation acceptance remains separate.

The repository's pinned LICENSE is MIT. Research source stays outside this repository; fixtures are independently authored. No dependency or upstream execution is needed.

## Observed baseline and required acceptance

Engineering diagnostics on the verification host used the complete clean parent and fix, respectively 32,387 and 32,388 tracked files, with unchanged production `extract-data` defaults. Both passed. The parent emitted 191 migrations; the fix emitted 192. Both emitted 771 tables and 9,640 columns. Neither emitted a migration target fact. The data source reported 16 dynamic DDL blocks at the parent and 17 at the fix. These are data-extractor diagnostics, not full CLI acceptance, findings, precision or recall.

The implementation must run the complete parent and fix through the production CLI, using the same extractor and sandbox limits as other development entries. It must show the early `public.children` reference as an X8 contradiction at the parent and examine the restored reference without that contradiction at the fix. Other withheld references and pipeline failures must be shown separately. A SQL-only subset, a larger limit, a skipped procedural block, or UNKNOWN for the restored reference cannot satisfy the fixed negative. Any failure leaves acceptance pending; it does not justify substituting another consumer or relabelling the expected result.

## Claim and two facts

X8 compares declared table and column state at a statement's position in an ordered migration group. The finding says that a reference requires a local table or column before that object's declared creation in that group's replay. Its evidence is the extracted reference and the extracted replay state, with the later creation as a witness. The report says "absent at this point in the declared migration replay". It does not claim that a request failed, that the current database lacks the object, or that the migration history can execute successfully in every environment.

Replay is static analysis of declared DDL. It never connects to a database or executes SQL, functions, modules or migration tools. Runtime state, event triggers, externally installed extensions and arbitrary application behavior are outside that claim. An unsupported statement that could change the declared table/column state prevents absence credit for the objects it could affect. Treating arbitrary procedural text as harmless because a keyword was absent is prohibited.

The reconstruction starts with an empty group-local declared catalog. It does not seed historical migrations with a current Prisma, Drizzle or standalone SQL snapshot. A table or column never created by that migration group is an external reference, not an orphan finding. Count it and explain the withheld reference. Groups do not lend each other declarations or ordering. An ambiguous group, duplicate ordering key, unsupported dialect or unread candidate with possible group relevance prevents the affected absence claim. Renaming a group cannot silently move a declaration into another group's history.

## Ordering is part of the evidence

The existing comparator in `packages/extract-data/src/discover.ts` compares leading integers first. For this consumer it places the 12-digit version `202607220012` before the 14-digit version `20260721174116`, the reverse of filename order. The baseline measurements above used that existing comparator. They establish no correct reference-point replay.

For a supported Supabase group, use lexical filename order over direct SQL migration files matching its digit-prefix convention, without converting the prefix to a Number. The pinned [Supabase migration reader](https://github.com/supabase/cli/blob/5afad870388552d0198087d27037da7ac745ba2b/apps/cli-go/pkg/migration/list.go#L33-L63) iterates `fs.ReadDir` results and retains their order; [Go's ReadDir contract](https://pkg.go.dev/io/fs#ReadDir) orders entries by filename. Its [filename parser](https://github.com/supabase/cli/blob/5afad870388552d0198087d27037da7ac745ba2b/apps/cli-go/pkg/migration/file.go#L29-L52) accepts variable-width digit prefixes as strings. These sources justify this supported declarative policy; they do not attest which upstream binary or command ran historically.

Recognize the group only in the direct `migrations` directory of a positively parsed supported Supabase project configuration, including the consumer's `supabase/config.toml`. Require migration support to be enabled and its relevant paths to be within the supported convention; malformed, dynamic or unsupported configuration cannot certify order. Apply the reader's filename acceptance and legacy-init exclusion; do not quietly include a file the supported reader would skip. Ambiguous projects, unread configuration, unsupported nesting or duplicate version strings make group ordering unknown. Do not apply this Supabase rule to arbitrary migration directories. Other groups need a separately justified framework policy; agreement of numeric and lexical guesses alone cannot certify order. Without such a policy, withhold X8 replay for that group. This does not generalize Supabase lexical order to numeric Flyway versions.

For an admitted group, final schema replay and the new reference replay must use the same proven order. Record a versioned order policy in the replay facts. Do not change Migration's natural key: order changes its ordinal and derived facts, not its version/name identity. A path rename that changes group or framework recognition must recompute order, authority and completeness, and cannot leave an earlier proof usable. Add mixed-width versions, huge prefixes, leading zeros, duplicate versions, skipped files, config deletion and project/group rename tests. Review any final-schema or baseline consequence separately as required by CONTRIBUTING.

## Replay and supported forms

Use the existing SQL tokenizer, identifier rules and source limits. Preserve statement order inside a file. Migration order must follow the supported framework policy below, not a numeric-prefix guess. Do not predeclare a table because a later statement creates it. Discovery may collect declarations for the external-reference distinction, but that lookahead cannot populate earlier catalog state.

Track table and column presence as known present, known absent or unknown. Recognized CREATE, ALTER, DROP and rename operations update that state in order. Honor IF EXISTS and IF NOT EXISTS against the state at that position; unknown conditions join both possible outcomes. A skipped CREATE cannot donate its body columns. DROP followed by CREATE begins a new lifetime. ALTER of an unknown or external table does not manufacture a complete table. Schema, quoted names, data source and migration group participate in resolution; suffix matching is insufficient.

Collect references from supported ALTER targets, index column lists and both inline and table-level foreign keys. Validate the grammar and all referenced columns, including composite foreign keys. A CREATE's own columns are available to its self-references. Distinguish a missing local table from a missing local column. Do not classify a missing unique constraint, index, function, type, row, permission or data value as a missing table or column. A later DROP must not retroactively make a valid earlier reference an orphan.

Procedural support is a bounded parser and effect analysis, not an execution facility. Initially support only closed forms needed by the consumer:

- Literal catalog-existence guards, including table guards used by the restored foreign key; branch analysis must preserve what each guard proves.
- Enum and aggregate definitions, and ALTER FUNCTION settings, whose checked forms do not create, drop or rename tables or columns.
- Guarded ALTER TABLE constraint additions, validating references on every feasible branch that executes the addition.
- Finite FOREACH loops over literal identifier arrays whose sole operation is a checked ALTER TABLE ENABLE ROW LEVEL SECURITY. A recognized constant format template and identifier substitution must be checked structurally; arbitrary EXECUTE, formatting, concatenation, calls or loop bodies are unsupported.
- Checked privilege changes, CHECK-constraint additions and constraint removals that do not change table/column membership. The consumer also has a catalog lookup followed by a constant ALTER TABLE DROP CONSTRAINT format template; the catalog-derived constraint identifier must occupy only the checked identifier position. Unsupported expressions still cannot supply positive reference or condition evidence.

Every accepted block must consume its entire syntax, including declarations, conditions and nested bodies. Reject trailing statements, exception handlers, unsupported languages, dynamic identifiers and unknown calls. Bound nesting and work within explicit implementation limits; exhaustion withholds, never produces empty success. A finite effect footprint may taint named objects only when the parser proves that footprint complete. An unbounded footprint taints the rest of the group. Later supported operations may recover facts they positively establish, but cannot erase an unknown history by omission. Unknown reference validity and unknown catalog membership are separate: a guarded constraint can leave a reference unproved without being allowed to invent arbitrary tables.

The seven procedural blocks before the cited parent reference need this analysis. Hand inspection of their apparent intent is no producer fact. The new restoration adds another block. The implementation must show which parser branches and state facts support the reference-specific parent/fix result.

## Stored facts and detector

Use scalar props on existing Migration and DataSource nodes. Do not change the ontology contract, node kinds, store API or public exports. Preserve Migration identity under ADR0016. A statement offset or source line is evidence, never part of an identity.

Version the replay fact format. On every examined migration, emit sorted canonical JSON scalar props for unresolved local references, external references, unknown references and their counts, including explicit empty sets. Each unresolved record identifies the qualified target, table or column role, statement position, absence state and creation witness. Use existing canonical name construction; do not concatenate ambiguous identifier segments. Store no raw SQL. The creation witness must resolve to a current live fact Migration in the same repo, data source, group and replay epoch; same-file ordering uses that Migration's statement positions. The detector validates the format, counts and witness agreement before using it.

A missing, stale, malformed or unsupported format is unknown, not a zero. The producer's full reference and mutation inventory must complete within its limits before it can certify absence. Do not derive a complete inventory from the list of references it happened to recognize. Unread candidates and unsupported statement shapes must be represented in authority and replay completeness. A partial or retried run cannot combine an old positive with new empty props. Keep existing authoritative selectors, tombstones and restoration behavior; add real-store lifecycle tests.

Replace both legacy X8 routes when implementing this design. Current-schema absence and tombstoned MIGRATED_BY endpoints cannot establish absence at a historical statement. Inferred edges, old targetTable/targetColumn props and final-schema suffix matches must not bypass replay proof. Findings require live fact provenance on every supporting node, a current PASS data scope and the complete affected replay evidence. Report withheld external and unknown references with reasons. A known contradiction elsewhere does not make an unexamined reference a passing negative.

## Verification and delivery

The implementation requires independently authored extraction fixture pairs for framework ordering and its refusal cases, early and late creation, multiple references in one statement, self-reference, composite columns, quoted names, separate groups, conditional creation, guarded constraints, rename, drop and recreate, and never-created external objects. Include opaque blocks, malformed tails, unknown conditions, unread and over-limit sources, ambiguous ordering and unsupported dialects. A block that creates the target before the reference must defeat a proposed absence claim. Mutation checks must kill removal of those controls, not merely a change in output counts.

Exercise the real sandbox and SQLite store: positive to valid fix; positive to unsupported input; deletion; same-run retry; tombstone and restoration; and group/path rename with the identities ADR0016 allows. Compare byte output across repeated extractions and Node 22.13 and 24. Unknown, unavailable and resource-limited runs cannot sweep protected facts or produce a finding through the old routes.

Keep any changed dogfood baseline in its own reviewed PR. Run the full verification, leak scans and recursive publish dry-run on the verification host. Require the six fresh review roles and a pinned signed-off squash after green CI. Implementation merge additionally requires the complete real-source parent/fix proof above. This engineering pair supplies no sealed partition credit, calibration sample, independent reviewer identity or proof that the original precision and recall bars have been reached.
