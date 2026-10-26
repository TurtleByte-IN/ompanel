import { createFileRoute } from "@tanstack/react-router";
import { OmpSettingsPanel } from "../components/settings/OmpSettingsPage";

export const Route = createFileRoute("/_chat/settings/omp-memory")({
  component: () => <OmpSettingsPanel pageId="memory" />,
});
