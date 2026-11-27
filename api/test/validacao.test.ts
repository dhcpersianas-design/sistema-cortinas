import { describe, expect, it } from 'vitest';
import {
  cnpjValido, cpfValido, formatarDocumento, formatarTelefone, linkWhatsapp, normalizarCep, normalizarDocumento, normalizarTelefone,
} from '../src/cadastros/validacao.js';

describe('telefone no padrão +55DDNNNNNNNNN', () => {
  it.each([
    ['(11) 98765-4321', '+5511987654321'],
    ['11987654321', '+5511987654321'],
    ['+55 11 98765-4321', '+5511987654321'],
    ['011 98765-4321', '+5511987654321'],
    ['0055 21 3333-4444', '+552133334444'],
    ['(31) 3333-4444', '+553133334444'],
  ])('%s → %s', (entrada, esperado) => {
    expect(normalizarTelefone(entrada)).toBe(esperado);
  });

  it.each(['', '12345', '(11) 8765-43210', '(10) 98765-4321', '11 88765-4321'])('recusa %s', (v) => {
    expect(normalizarTelefone(v)).toBeNull();
  });

  it('formata e gera link wa.me', () => {
    expect(formatarTelefone('+5511987654321')).toBe('(11) 98765-4321');
    expect(formatarTelefone('+553133334444')).toBe('(31) 3333-4444');
    expect(linkWhatsapp('+5511987654321')).toBe('https://wa.me/5511987654321');
    expect(linkWhatsapp('+5511987654321', 'Olá, João!')).toBe('https://wa.me/5511987654321?text=Ol%C3%A1%2C%20Jo%C3%A3o!');
    expect(linkWhatsapp(null)).toBeNull();
  });
});

describe('CPF / CNPJ', () => {
  it('confere dígitos verificadores', () => {
    expect(cpfValido('529.982.247-25')).toBe(true);
    expect(cpfValido('529.982.247-26')).toBe(false);
    expect(cpfValido('111.111.111-11')).toBe(false);
    expect(cnpjValido('11.222.333/0001-81')).toBe(true);
    expect(cnpjValido('11.222.333/0001-82')).toBe(false);
  });

  it('normaliza para dígitos e identifica PF/PJ', () => {
    expect(normalizarDocumento('529.982.247-25')).toEqual({ digitos: '52998224725', tipo: 'PF' });
    expect(normalizarDocumento('11.222.333/0001-81')).toEqual({ digitos: '11222333000181', tipo: 'PJ' });
    expect(normalizarDocumento('123')).toBeNull();
    expect(formatarDocumento('52998224725')).toBe('529.982.247-25');
    expect(formatarDocumento('11222333000181')).toBe('11.222.333/0001-81');
  });
});

describe('CEP', () => {
  it('aceita com ou sem hífen', () => {
    expect(normalizarCep('01310100')).toBe('01310-100');
    expect(normalizarCep('01310-100')).toBe('01310-100');
    expect(normalizarCep('0131010')).toBeNull();
  });
});
