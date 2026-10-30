Throwaway keys for `check:sso` only. `idp-*` plays a company's identity
provider signing its assertions; `other-*` is somebody else's key, for the
check that a signature by any other key is refused. They sign nothing real
and are trusted by nothing outside the suite.
