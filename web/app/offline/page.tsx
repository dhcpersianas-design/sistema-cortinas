export const dynamic = 'force-static';

export default function Offline() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 text-center">
      <div className="max-w-sm">
        <h1 className="mb-2 text-xl font-semibold">Sem conexão</h1>
        <p className="text-sm text-muted-foreground">
          Esta tela ainda não foi aberta neste aparelho com internet. As telas já visitadas
          continuam funcionando; o que você registrar offline é enviado quando a conexão voltar.
        </p>
      </div>
    </main>
  );
}
