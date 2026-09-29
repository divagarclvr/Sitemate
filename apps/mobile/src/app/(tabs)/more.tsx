import type { AiDiagnostics, ProviderCheck } from "@sitemate/shared";
import { useMutation } from "@tanstack/react-query";
import { BigButton, Body, Card, ErrorBox, Screen, Title } from "@/components/ui";
import { hasOwnRecordingService } from "@/audio/foregroundService";
import { api, ApiRequestError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { config } from "@/lib/config";
import { supabase } from "@/lib/supabase";

function failureHint(error: string | null) {
  const e = (error ?? "").toLowerCase();
  if (e.includes("busy") || e.includes("high demand")) {
    return "Google's free servers are busy right now — not a problem with your key. SiteMate uses the backup AI meanwhile; try again later.";
  }
  if (e.includes("limit")) return "Today's free limit is used up. It resets automatically; the backup AI is used meanwhile.";
  return "Check this provider's API key and model name in the server settings.";
}

function ProviderResult({ label, check }: { label: string; check: ProviderCheck }) {
  return (
    <Card>
      <Body>
        {check.ok ? "✅" : "❌"} {label}: {check.provider} · {check.model}
      </Body>
      {check.reply ? <Body>{check.reply}</Body> : null}
      {check.error ? <Body muted>{check.error}</Body> : null}
      {!check.ok && <Body muted>{failureHint(check.error)}</Body>}
      <Body muted>
        {(check.latency_ms / 1000).toFixed(1)} s
        {check.input_tokens != null ? ` · ${check.input_tokens} in / ${check.output_tokens} out tokens` : ""}
      </Body>
    </Card>
  );
}

export default function MoreScreen() {
  const { session } = useAuth();

  const health = useMutation({
    mutationFn: () => api<{ ok: boolean; time: string }>("/health"),
  });
  const aiTest = useMutation({
    mutationFn: () => api<AiDiagnostics>("/v1/diagnostics/ai", { method: "POST", body: "{}" }),
  });

  const showError = (e: unknown) =>
    e instanceof ApiRequestError ? <ErrorBox message={e.message} hint={e.hint} /> : <ErrorBox message={String(e)} />;

  return (
    <Screen>
      <Title>More</Title>
      <Card>
        <Body muted>Signed in as</Body>
        <Body>{session?.user.email}</Body>
        <Body muted>Server: {config.apiBaseUrl || "(not set)"}</Body>
        <Body muted>
          Screen-off recording: {hasOwnRecordingService ? "✅ available in this app" : "❌ not in this app build — install the latest SiteMate APK"}
        </Body>
      </Card>

      <Title>Connection check</Title>
      <BigButton label="Check server" variant="secondary" onPress={() => health.mutate()} loading={health.isPending} />
      {health.data && <Body>✅ Server is running ({new Date(health.data.time).toLocaleTimeString()})</Body>}
      {health.error && showError(health.error)}

      <BigButton label="Test AI" onPress={() => aiTest.mutate()} loading={aiTest.isPending} />
      {aiTest.isPending && <Body muted>Asking the AI… first try can take up to a minute if the server was asleep.</Body>}
      {aiTest.data && <ProviderResult label="Main AI" check={aiTest.data.main} />}
      {aiTest.data?.fallback && <ProviderResult label="Backup AI" check={aiTest.data.fallback} />}
      {aiTest.error && showError(aiTest.error)}

      <Body muted>Contacts, Projects, Settings and Usage arrive in later phases.</Body>
      <BigButton label="Sign out" variant="danger" onPress={() => supabase.auth.signOut()} />
    </Screen>
  );
}
