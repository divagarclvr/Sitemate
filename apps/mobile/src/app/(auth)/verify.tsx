import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { BigButton, Body, ErrorBox, Field, Screen, Title } from "@/components/ui";
import { supabase } from "@/lib/supabase";

export default function VerifyScreen() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async () => {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: "email" });
    setBusy(false);
    // On success the auth listener switches the app to the tabs automatically.
    if (error) setError(error.message);
  };

  return (
    <Screen>
      <Title>Enter your code</Title>
      <Body muted>We sent a 6-digit code to {email}. It can take a minute — check spam too.</Body>
      <Field
        label="Code"
        value={code}
        onChangeText={(v) => setCode(v.replace(/\D/g, ""))}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        maxLength={8}
        placeholder="123456"
      />
      {error && <ErrorBox message="That code didn't work" hint={`${error}. Ask for a new code if it expired.`} />}
      <BigButton label="Sign in" onPress={verify} loading={busy} disabled={code.length < 6} />
      <BigButton label="Use a different email" variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
