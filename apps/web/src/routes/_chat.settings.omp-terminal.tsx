import { createFileRoute } from "@tanstack/react-router";
import { OmpSettingsPanel } from "../components/settings/OmpSettingsPage";

export const Route = createFileRoute("/_chat/settings/omp-terminal")({
  component: () => <OmpSettingsPanel pageId="terminal" />,
});
