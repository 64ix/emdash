# Awaiting-input elevation is render-time only, never persisted

Cards whose task has a session awaiting input float to the top of their
Feature Board column, but this is a render-time partition: `board_rank` is
only ever written by an explicit user drop. We rejected persisting the
bump because a system that writes into a manual ordering silently corrupts
the user's arrangement every time an agent asks a question. A future
reader tempted to "fix" the elevation by saving it should not. While a
drag is active the partition is frozen so the list cannot reshuffle under
the pointer.
