- [2026-11-03] Reject malformed client input once, at the edge, with an error that carries its own status — never by translating a downstream failure per route. The shape that works:

      class InvalidInputError extends Error {
        constructor(message) { super(message); this.statusCode = 400; }
      }

      function requireObject(value, what) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new InvalidInputError(`${what} must be a JSON object`);
        }
        return value;
      }

  Define the guard once and call it from every entry point before any payload field is read, so every path answers with the same wording and no engine-internal message can reach a client. Attaching a status where an error is caught fixes one path and leaves the others carrying the bug.
