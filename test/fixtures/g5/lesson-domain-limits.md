- [2026-11-03] When a value breaks a rule about itself — beyond its limit, not a whole number, a transition that is not allowed — the check belongs beside the rule and raises an error that carries its own status: `class DomainLimitError extends Error { constructor(message, status = 422) { super(message); this.statusCode = status; } }`. Define the guard once and call it wherever the limit is known:

      function assertWithinRange(value, max, what) {
        if (typeof value !== "number" || !Number.isInteger(value) || value > max) {
          throw new DomainLimitError(`${what} must be a whole number no greater than ${max}`);
        }
        return value;
      }

  Every caller then reports what the type already says. Reformatting an error where it happens to be caught fixes only the path that caught it, and the next caller repeats the mistake.
