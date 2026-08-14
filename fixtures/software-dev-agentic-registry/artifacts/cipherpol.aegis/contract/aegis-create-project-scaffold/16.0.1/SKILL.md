---
name: aegis-create-project-scaffold
description: Create a new Flutter project with catalog-pinned dependencies and SDK constraints — flutter create, pubspec composition, Android minSdk, iOS deployment target, pub get verification.
user-invocable: false
allowed-tools: Bash, Read, Write, Edit, Glob
---

Create a new Flutter project at `<target_dir>/<project_name>` with the exact dependency pins provided by the caller. Never choose or adjust a version — pins arrive resolved from the catalog.

## Steps

1. **Precondition** — `<target_dir>/<project_name>` must NOT exist; STOP if it does.
2. **Create** — `flutter create --org <org> --project-name <project_name> <target_dir>/<project_name>`
3. **Compose `pubspec.yaml`:**
   - `environment.sdk` from `requirements.sdk`
   - each resolved dependency under `dependencies:` with its exact pin — plain versions as `package: x.y.z`, git dependencies as the full `git:` block (url/ref/path) verbatim
   - provided tooling pins under `dev_dependencies:`
   - provided `overrides` under `dependency_overrides:` verbatim
4. **Native constraints:**
   - Android: set `minSdk` in `android/app/build.gradle` (or `.gradle.kts`) to satisfy the `min_sdk` operator from the caller's android constraints
   - iOS: set the `platform :ios, 'X.Y'` line in `ios/Podfile` (uncomment if needed) to satisfy `deployment_target`
5. **Verify** — run `flutter pub get` in the project. Non-zero exit → report the full resolver output as failure; do not mask or retry with altered pins.

## Output

List every file created or modified, the applied SDK constraints, and the `flutter pub get` result (pass/fail with output on failure).
