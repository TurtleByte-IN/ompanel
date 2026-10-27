import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { PRODUCT_NAME, REPOSITORY_URL } from "@t3tools/shared/brand";
import { InfoIcon } from "lucide-react";

import { serverEnvironment } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";

const PROVIDER_DOCS = `${REPOSITORY_URL}/blob/main/docs/user`;

const PROVIDERS = new Map<string, { readonly name: string; readonly docsUrl: string }>([
  [
    "codex",
    { name: "Codex", docsUrl: `${PROVIDER_DOCS}/providers-codex.md#use-multiple-accounts` },
  ],
  [
    "claudeAgent",
    {
      name: "Claude",
      docsUrl: `${PROVIDER_DOCS}/providers-claude.md#separate-accounts-or-configurations`,
    },
  ],
]);

/** Shown while adding a Claude or Codex account when the environment already has one signed in. */
export function MultipleAccountsNote({
  environmentId,
  driver,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: ProviderDriverKind;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const provider = PROVIDERS.get(driver);
  const hasSignedInAccount =
    provider !== undefined &&
    providers?.some((entry) => entry.driver === driver && entry.auth.status === "authenticated");
  if (!hasSignedInAccount || provider === undefined) return null;
  return (
    <Alert variant="info" role="note">
      <InfoIcon aria-hidden />
      <AlertDescription>
        <p>
          We do not recommend managing multiple {provider.name} accounts in {PRODUCT_NAME}.{" "}
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            More info
          </a>
        </p>
      </AlertDescription>
    </Alert>
  );
}
