# Application and station boundary

A campaign proposes numeric parameter values, binds them into a protocol snapshot and submits the complete YAML bundle to CubOS. CubOS validates the bundle, reserves execution resources, executes it, persists results and updates authoritative inventory. Ursa Learning polls the addressable run, validates measurement provenance, records an objective and proposes the next trial.

Each native submission uses a stable run ID. Network uncertainty must be resolved by reading that ID; it must not create another protocol run. Pauses and batch refill waits retain orchestration state without inventing a second physical-state database.

Scalar objectives are independent of the color adapter. Color setup compiles an ordinary campaign specification: mixture parameter bounds, sum constraints, protocol bindings, targets and result paths. Overnight queues persist frozen setup for several campaigns and require an explicit operator start.

Original hardware image paths are identifiers from remote execution, not local filesystem paths. The CubOS API publishes immutable artifacts with hashes. The external app downloads those bytes, checks the recorded hash, and stores its own review revisions and evidence exports.

The application imports no CubOS runtime package. Camera color analysis is pure computation, and its processing schema is retained so accepted measurements can be compared consistently across the extraction.
