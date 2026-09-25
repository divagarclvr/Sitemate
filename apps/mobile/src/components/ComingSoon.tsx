import { Body, Card, Screen, Title } from "./ui";

export function ComingSoon({ title, phase, lines }: { title: string; phase: number; lines: string[] }) {
  return (
    <Screen>
      <Title>{title}</Title>
      <Card>
        <Body muted>Coming in Phase {phase}:</Body>
        {lines.map((l) => (
          <Body key={l}>• {l}</Body>
        ))}
      </Card>
    </Screen>
  );
}
