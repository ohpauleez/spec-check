module final_report

// Bounded lifecycle model for optional post-completion report generation.

// --- Immutable artifact identity ---

abstract sig Artifact {}
one sig Summary, FinalReport extends Artifact {}

// --- Lifecycle states ---

abstract sig Stage {}
one sig Preparing, CoreReporting, CoreComplete, Generating, Validating,
  Cleaning, Cleaned, MarkerInvalidated, SummaryRewritten, ManifestRefreshing, ReportAvailable,
  WarningPersisted, OutputFailed extends Stage {}

one sig Run {
  var stage: one Stage,
  var coreComplete: one Int,
  var reportPresent: one Int,
  var reportValid: one Int,
  var warningPresent: one Int,
  var summaryCurrent: one Int,
  var manifestCurrent: one Int,
  var manifested: set Artifact
}

// Boolean-valued Int fields are constrained to 0 or 1 in every state.
fact BooleanFields {
  always {
    Run.coreComplete in 0 + 1
    Run.reportPresent in 0 + 1
    Run.reportValid in 0 + 1
    Run.warningPresent in 0 + 1
    Run.summaryCurrent in 0 + 1
    Run.manifestCurrent in 0 + 1
  }
}

// --- Initialization ---

pred init {
  Run.stage = Preparing
  Run.coreComplete = 0
  Run.reportPresent = 0
  Run.reportValid = 0
  Run.warningPresent = 0
  Run.summaryCurrent = 0
  Run.manifestCurrent = 0
  no Run.manifested
}

// --- Events with complete frame conditions ---

pred begin_core_reporting {
  Run.stage = Preparing
  Run.stage' = CoreReporting
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred complete_core {
  Run.stage = CoreReporting
  Run.stage' = CoreComplete
  Run.coreComplete' = 1
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = 1
  Run.manifestCurrent' = 1
  Run.manifested' = Summary
}

pred start_report {
  Run.stage = CoreComplete
  Run.coreComplete = 1
  Run.stage' = Generating
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred generation_returns {
  Run.stage = Generating
  Run.stage' = Validating
  Run.coreComplete' = Run.coreComplete
  // Candidate presence is not trusted until filesystem validation.
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred generation_fails {
  Run.stage = Generating
  Run.stage' = Cleaning
  Run.coreComplete' = Run.coreComplete
  // Candidate residue is abstracted until cleanup; only validated presence is authoritative.
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = 0
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred validation_succeeds {
  Run.stage = Validating
  Run.stage' = ReportAvailable
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = 1
  Run.reportValid' = 1
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred validation_fails {
  Run.stage = Validating
  Run.stage' = Cleaning
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred cleanup_succeeds {
  Run.stage = Cleaning
  Run.stage' = Cleaned
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = 0
  Run.reportValid' = 0
  Run.warningPresent' = 1
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred invalidate_marker {
  Run.stage = Cleaned
  Run.stage' = MarkerInvalidated
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = 0
  Run.manifestCurrent' = 0
  no Run.manifested'
}

pred rewrite_summary {
  Run.stage = MarkerInvalidated
  Run.stage' = SummaryRewritten
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = 1
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred begin_manifest_refresh {
  Run.stage = SummaryRewritten
  Run.stage' = ManifestRefreshing
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred manifest_refresh_succeeds {
  Run.stage = ManifestRefreshing
  Run.stage' = WarningPersisted
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = 1
  Run.manifested' = Summary
}

pred output_fails {
  Run.stage in Cleaning + Cleaned + MarkerInvalidated + SummaryRewritten + ManifestRefreshing
  Run.stage' = OutputFailed
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred stutter {
  Run.stage' = Run.stage
  Run.coreComplete' = Run.coreComplete
  Run.reportPresent' = Run.reportPresent
  Run.reportValid' = Run.reportValid
  Run.warningPresent' = Run.warningPresent
  Run.summaryCurrent' = Run.summaryCurrent
  Run.manifestCurrent' = Run.manifestCurrent
  Run.manifested' = Run.manifested
}

pred next {
  begin_core_reporting
  or complete_core
  or start_report
  or generation_returns
  or generation_fails
  or validation_succeeds
  or validation_fails
  or cleanup_succeeds
  or invalidate_marker
  or rewrite_summary
  or begin_manifest_refresh
  or manifest_refresh_succeeds
  or output_fails
  or stutter
}

fact Traces {
  init
  always next
}

// Action-progress assumptions for liveness checks only. Safety checks do not
// depend on them, and output failure remains an allowed terminal result.
pred report_fairness {
  always (Run.stage = CoreComplete implies eventually start_report)
  always (Run.stage = Generating implies eventually (generation_returns or generation_fails))
  always (Run.stage = Validating implies eventually (validation_succeeds or validation_fails))
  always (Run.stage = Cleaning implies eventually (cleanup_succeeds or output_fails))
  always (Run.stage = Cleaned implies eventually (invalidate_marker or output_fails))
  always (Run.stage = MarkerInvalidated implies eventually (rewrite_summary or output_fails))
  always (Run.stage = SummaryRewritten implies eventually (begin_manifest_refresh or output_fails))
  always (Run.stage = ManifestRefreshing implies eventually (manifest_refresh_succeeds or output_fails))
}

// --- Safety properties ---

assert report_starts_after_core_completion {
  always (Run.stage in Generating + Validating + Cleaning + Cleaned + MarkerInvalidated + SummaryRewritten
    + ManifestRefreshing + ReportAvailable + WarningPersisted + OutputFailed
    implies Run.coreComplete = 1)
}

assert core_completion_is_monotonic {
  always (Run.coreComplete = 1 implies Run.coreComplete' = 1)
}

assert final_report_is_never_manifested {
  always FinalReport not in Run.manifested
}

assert report_terminal_is_valid {
  always (Run.stage = ReportAvailable implies {
    Run.reportPresent = 1
    Run.reportValid = 1
    Run.warningPresent = 0
    Run.coreComplete = 1
  })
}

assert warning_terminal_has_no_report {
  always (Run.stage = WarningPersisted implies {
    Run.reportPresent = 0
    Run.reportValid = 0
    Run.warningPresent = 1
    Run.summaryCurrent = 1
    Run.manifestCurrent = 1
    Run.coreComplete = 1
  })
}

assert terminal_outcomes_are_exclusive {
  always not (Run.stage = ReportAvailable and Run.stage = WarningPersisted)
  always (Run.stage = ReportAvailable implies Run.warningPresent = 0)
  always (Run.stage = WarningPersisted implies Run.reportPresent = 0)
}

assert terminal_states_stutter {
  always (Run.stage in ReportAvailable + WarningPersisted + OutputFailed implies Run.stage' = Run.stage)
}

assert manifested_core_is_current {
  always (some Run.manifested implies {
    Summary in Run.manifested
    Run.summaryCurrent = 1
    Run.manifestCurrent = 1
  })
}

assert refresh_window_has_no_stale_manifest {
  always (Run.stage in MarkerInvalidated + SummaryRewritten + ManifestRefreshing implies {
    Run.manifestCurrent = 0
    no Run.manifested
  })
}

// --- Liveness under explicit fairness ---

assert attempted_report_eventually_terminates {
  report_fairness implies always (
    Run.stage = Generating implies eventually Run.stage in ReportAvailable + WarningPersisted + OutputFailed
  )
}

assert completed_core_eventually_attempts_report {
  report_fairness implies always (
    Run.stage = CoreComplete implies eventually Run.stage = Generating
  )
}

assert completed_core_eventually_reaches_report_outcome {
  report_fairness implies always (
    Run.stage = CoreComplete implies eventually Run.stage in ReportAvailable + WarningPersisted + OutputFailed
  )
}

// --- Witnesses and bounded checks ---

run success_path {
  eventually Run.stage = ReportAvailable
} for 4 but exactly 8 steps expect 1

run generation_failure_path {
  eventually Run.stage = WarningPersisted
} for 4 but exactly 11 steps expect 1

run validation_failure_path {
  eventually (Run.stage = Validating and after Run.stage = Cleaning)
  eventually Run.stage = WarningPersisted
} for 4 but exactly 11 steps expect 1

run output_failure_path {
  eventually Run.stage = OutputFailed
} for 4 but exactly 9 steps expect 1

check report_starts_after_core_completion for 4 but 12 steps expect 0
check core_completion_is_monotonic for 4 but 12 steps expect 0
check final_report_is_never_manifested for 4 but 12 steps expect 0
check report_terminal_is_valid for 4 but 12 steps expect 0
check warning_terminal_has_no_report for 4 but 12 steps expect 0
check terminal_outcomes_are_exclusive for 4 but 12 steps expect 0
check terminal_states_stutter for 4 but 12 steps expect 0
check manifested_core_is_current for 4 but 12 steps expect 0
check refresh_window_has_no_stale_manifest for 4 but 12 steps expect 0
check attempted_report_eventually_terminates for 4 but 12 steps expect 0
check completed_core_eventually_attempts_report for 4 but 12 steps expect 0
check completed_core_eventually_reaches_report_outcome for 4 but 12 steps expect 0
