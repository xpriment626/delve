# Contributing

## Source Checkout Development

```bash
npm install
npm run check
npm test
npm run build
npm run install-local
delve --json doctor
```

Manual foreground Coral server from a source checkout:

```bash
npm run coral:start
```

Normal npm users should let `delve research run` auto-start Coral.

## Publishing

The package is configured for public scoped npm publishing:

```bash
npm whoami
npm run check
npm test
npm run build
npm pack --dry-run
npm publish
```

If npm two-factor authentication is enabled, publish with a current one-time password:

```bash
npm publish --otp <six-digit-code>
```

The package name is `@itsshadowai/delve`; the binary remains `delve`.
