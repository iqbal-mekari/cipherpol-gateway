# Example: Search a codebase

**User:** How does the payment flow work in my-app?

**Claude uses:**
```
search("my-app", "payment flow", ref="branch:main", k=8)
```

Returns the top symbols related to payments (e.g. `PaymentBloc`, `PaymentRepository`, `PaymentApi`).

Then drills in:
```
get_symbol("my-app", fqn="payment.PaymentBloc", ref="branch:main")
get_neighbors("my-app", fqn="payment.PaymentBloc", ref="branch:main")
```

**Result:** Claude describes the payment flow with exact file paths, class names, and the sequence of calls from UI → BLoC/ViewModel → repository → API.
