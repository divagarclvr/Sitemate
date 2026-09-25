import { router } from "expo-router";
import { useState } from "react";
import { BigButton, Body, ErrorBox, Field, Screen, Title } from "@/components/ui";
import { missingConfig } from "@/lib/config";
import { supabase } from "@/lib/supabase";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase() });
    setBusy(false);
    if (error) return setError(error.message);
    router.push({ pathname: "/verify", params: { email: email.trim().toLowerCase() } });
  };

  return (
    <Screen>
      <Title>SiteMate</Title>
      <Body muted>Your site meeting assistant. Sign in with your email — we'll send you a 6-digit code.</Body>

      {missingConfig.length > 0 && (
        <ErrorBox
          message={`App settings missing: ${missingConfig.join(", ")}`}
          hint="Fill in apps/mobile/.env (see README, Phase 1) and restart with: npx expo start --clear"
        />
      )}

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        placeholder="you@example.com"
      />
      {error && <ErrorBox message="Couldn't send the code" hint={error} />}
      <BigButton label="Send code" onPress={sendCode} loading={busy} disabled={!email.includes("@")} />
    </Screen>
  );
}
