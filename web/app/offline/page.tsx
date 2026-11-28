import { TelaMarca } from '@/components/tela-marca';

export const dynamic = 'force-static';

export default function Offline() {
  return (
    <TelaMarca
      titulo="Sem conexão"
      subtitulo="Esta tela ainda não foi aberta neste aparelho com internet. As telas já visitadas continuam funcionando; o que você registrar offline é enviado quando a conexão voltar."
    />
  );
}
