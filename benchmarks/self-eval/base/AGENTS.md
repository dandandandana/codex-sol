# Self-evaluation base project

This directory is the isolated starting project for the local self-evaluation benchmark. Keep changes in the files allowed by the selected task and reuse the registered modules in `components.json` when they provide the required behavior.

Validate inputs at each public boundary. Reject invalid input with an appropriate error, and let errors from called modules, readers, callbacks, and operations propagate unless the task contract explicitly says otherwise. Do not convert failures into successful-looking fallback values.

Do not edit benchmark tests or task definitions while solving a task. Do not install dependencies or use `npm exec` / `npx`; the base project has no dependencies and is intended to run locally.
