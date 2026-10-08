# Accessibility and internationalisation

> keylos treats assistive technology as a first-class principal with an explicit, high-tier grant: it sees the screen and can act, so it is trusted deliberately rather than by default. Locales, input methods, fonts and translations are data generations, shared by every app through the store.

Status: **specified (v1.0)**. Normative specs: [atrium](../../specs/atrium/spec.md) (accessibility aggregator, built-in aids, input methods) and [portals](../../specs/portals/spec.md) (Accessibility portal).

## Accessibility architecture

```
app (GTK/Qt) ──AT-SPI on a private D-Bus inside its sandbox──► atrium-a11y-bridge (same principal)
app (AccessKit) ───────────────────────────────────────────────┐        │ a11y.capnp
trusted UI (egui + AccessKit) ──────────────────────────────►  atrium aggregator  ◄── portal-a11y ◄── screen reader
                                                                                           (assistive principal, T3)
```

| Piece | Role |
|---|---|
| `atrium-a11y-bridge` | Started by warden inside each GUI app when accessibility is on. It reads the app's AT-SPI tree from a private bus (a D-Bus island of one app) and translates it to `a11y.capnp` |
| Native AccessKit apps | Talk `a11y.capnp` directly; no bridge |
| atrium aggregator | Merges per-app trees under their toplevels, adds trusted UI trees, and routes actions back to the owning app |
| `portal-a11y` | Hands the aggregated tree to assistive principals |

### Why a grant, and why T3

An assistive principal reads everything on screen and can act in any app. That is the same power as a keylogger plus input injection. keylos therefore:
- requires the app to declare `portal-a11y` in `needs.services` (the portal's `default` facet is routed only to assistive-technology principals);
- requires a persistent T3 grant, approved once by the owner;
- raises the assistive principal's label to `private`, so policy can keep it away from egress (Rule of Two);
- shows "assistive technology active" in the keystrip.

Trusted prompts are readable by screen readers. Without that, keylos would be unusable for blind users; the T3 grant is the trade-off.

## Built-in aids (no grant needed)

| Aid | Notes |
|---|---|
| Magnifier | Compositor zoom with pointer, focus and caret tracking |
| High contrast, large text | For trusted UI and atrium's shell clients; exported to apps as a settings preference |
| Reduced motion | Disables compositor animations; exported as a preference |
| Cursor size and colour | Compositor cursor |
| Sticky, slow and bounce keys | In atrium's input pipeline, before any client sees events |
| On-screen keyboard | `atrium-osk`, a trusted client; it can type into trusted fields too |
| Screen reader for greeter and lock | The trusted UI exposes its tree; a system screen reader can be enabled at the greeter with a shortcut |

## Internationalisation

| Area | keylos approach |
|---|---|
| Encoding | UTF-8 only, everywhere; no legacy charsets on the host |
| Locale data | ICU4X/CLDR data shipped as a `data` generation; glibc locales for legacy apps built into runtime generations |
| Time zones | System clock is UTC; tzdata is a data generation updated through normal updates; per-user time zone in user settings |
| Translations of keylos components | Fluent message bundles in each component's generation; trusted UI strings are part of atrium's sealed generation, so apps cannot alter them |
| App display names | From the manifest; localised names via the manifest `l10n` field and `/.keylos/l10n/<lang>.json` (summary, entrypoint names, `why` strings), which atrium reads for identity frames with bidi isolation and confusable checks |
| Right-to-left | Trusted UI and atrium-term support bidirectional text; identity frames isolate app-provided strings with Unicode bidi isolates, so an app title cannot reorder the frame |
| Confusables in identity | Display names in frames and prompts are checked against Unicode confusable skeletons (UTS #39); names mixing scripts or confusable with an installed app's name get a warning badge |
| Fonts | Font families are data generations shared through the store; apps see fonts through their runtime view; user-installed fonts are sealed into a personal data generation |
| Keyboard layouts | xkbcommon layouts per user; switching in the keystrip |
| Input methods | IME engines (for example fcitx5 with CJK engines) run as the `ime` class: input-method-v2 to the focused field only. Trusted fields use atrium's own xkb and compose handling, never a third-party IME |

### Bidi and confusables

Identity is shown as text, so text tricks are identity tricks:
- Unicode bidi overrides in a title could make "Bank – Approve" render as something else.
- A display name such as "Systеm Settings" (Cyrillic е) could impersonate a trusted app.

atrium therefore:
- wraps every app-provided string in a bidi isolate;
- strips bidi control characters from display names;
- flags confusable names using UTS #39 skeletons against the names of installed generations and keylos's own components.

## Limitations

- AT-SPI apps rely on the bridge, which adds latency (target ≤ 20 ms per tree update) compared with in-process AccessKit.
- Third-party IMEs cannot be used in trusted fields (passwords, prompts); CJK users type those with the built-in compose or a romanised fallback, or use the on-screen keyboard.
- Manifest localisation is an `x-` extension in protocols 1.0, so not every publisher provides it.

## Related

- [Desktop](desktop.md)
- [Portals and the powerbox](portals-and-powerbox.md)
- [Trusted path](../06-security/trusted-path.md)
- [atrium spec](../../specs/atrium/spec.md)
