import assert from 'node:assert/strict';
import test from 'node:test';
import { hexToHslChannels, readableForegroundChannels, buildBrandColorCss } from '../src/lib/brand-colors.ts';

// D10: cores de marca (hex) → canais HSL das CSS vars do tema. Aplicação segura (accent).

test('hexToHslChannels converte para os canais do formato das CSS vars', () => {
  assert.equal(hexToHslChannels('#0B6BD6'), '212 90% 44%'); // = o --primary padrão do index.css
  assert.equal(hexToHslChannels('#ffffff'), '0 0% 100%');
  assert.equal(hexToHslChannels('#000000'), '0 0% 0%');
  assert.equal(hexToHslChannels('0B6BD6'), '212 90% 44%', 'aceita sem #');
  assert.equal(hexToHslChannels('nao-hex'), null);
  assert.equal(hexToHslChannels(''), null);
});

test('readableForegroundChannels escolhe preto sobre claro e branco sobre escuro', () => {
  assert.equal(readableForegroundChannels('#ffffff'), '0 0% 0%', 'fundo claro → texto preto');
  assert.equal(readableForegroundChannels('#0B6BD6'), '0 0% 100%', 'fundo escuro → texto branco');
  assert.equal(readableForegroundChannels('cor-invalida'), '0 0% 100%', 'inválido → assume escuro → branco');
});

test('buildBrandColorCss: cores padrão ou vazias NÃO sobrescrevem nada (DRAC intocado)', () => {
  assert.equal(buildBrandColorCss({ useDefaultColors: true, primaryColor: '#ff0000' }), null);
  assert.equal(buildBrandColorCss({ useDefaultColors: false }), null);
  assert.equal(buildBrandColorCss({ useDefaultColors: false, primaryColor: 'lixo' }), null);
});

test('buildBrandColorCss: gera regras :root (claro) e .dark (escuro) do accent', () => {
  const css = buildBrandColorCss({ useDefaultColors: false, primaryColor: '#000000', lightPrimaryColor: '#ffffff' });
  assert.ok(css);
  assert.match(css!, /:root\{--primary:0 0% 100%;--ring:0 0% 100%;--primary-foreground:0 0% 0%;\}/);
  assert.match(css!, /\.dark\{--primary:0 0% 0%;--ring:0 0% 0%;--primary-foreground:0 0% 100%;\}/);
});

test('buildBrandColorCss: mapeia a PALETA completa (fundo/texto/borda/card/secondary/muted/accent) no tema claro', () => {
  const css = buildBrandColorCss({
    useDefaultColors: false,
    lightBackgroundColor: '#ffffff',      // fundo
    lightBackgroundTextColor: '#111827',  // texto sobre o fundo
    lightSurfaceColor: '#f3f5f9',         // superfície de card/painel
    lightTextColor: '#1a2230',            // texto sobre a superfície
    lightTextSubColor: '#4e5a6c',         // subtexto sobre a superfície
    lightBorderColor: '#d8dee8',          // bordas
  });
  assert.ok(css);
  // Fundo + texto do fundo
  assert.match(css!, /:root\{[^}]*--background:0 0% 100%;/);
  assert.match(css!, new RegExp(`:root\\{[^}]*--foreground:${hexToHslChannels('#111827')!};`));
  // Superfície replicada em card/popover/secondary/muted/accent
  const surface = hexToHslChannels('#f3f5f9')!;
  for (const v of ['--card', '--popover', '--secondary', '--muted', '--accent']) {
    assert.match(css!, new RegExp(`:root\\{[^}]*${v}:${surface};`), `esperava ${v} = superfície do cliente`);
  }
  // Foreground das superfícies vem do texto do cliente; muted-foreground do subtexto
  const surfFg = hexToHslChannels('#1a2230')!;
  const mutedFg = hexToHslChannels('#4e5a6c')!;
  assert.match(css!, new RegExp(`:root\\{[^}]*--card-foreground:${surfFg};`));
  assert.match(css!, new RegExp(`:root\\{[^}]*--muted-foreground:${mutedFg};`));
  // Bordas
  const border = hexToHslChannels('#d8dee8')!;
  assert.match(css!, new RegExp(`:root\\{[^}]*--border:${border};`));
  assert.match(css!, new RegExp(`:root\\{[^}]*--card-border:${border};`));
  assert.match(css!, new RegExp(`:root\\{[^}]*--popover-border:${border};`));
  // Escuro não foi informado → nenhum bloco .dark
  assert.ok(!/\.dark\{/.test(css!), 'sem cores escuras não deve emitir bloco .dark');
});

test('buildBrandColorCss: sem cor de texto, o foreground cai no contraste WCAG legível da própria superfície', () => {
  // Superfície escura sem texto informado → texto branco. Fundo claro sem texto → preto.
  const css = buildBrandColorCss({
    useDefaultColors: false,
    lightBackgroundColor: '#ffffff',   // claro → foreground preto
    lightSurfaceColor: '#000000',      // superfície preta → foreground branco
  });
  assert.ok(css);
  assert.match(css!, /--foreground:0 0% 0%;/);          // WCAG: preto sobre fundo claro
  assert.match(css!, /--card-foreground:0 0% 100%;/);   // WCAG: branco sobre card preto
  assert.match(css!, /--muted-foreground:0 0% 100%;/);  // idem para o subtexto
});

test('buildBrandColorCss: cor de superfície INVÁLIDA não emite nenhuma var de superfície', () => {
  const css = buildBrandColorCss({
    useDefaultColors: false,
    lightPrimaryColor: '#0B6BD6', // válida, garante que algo é emitido
    lightSurfaceColor: 'lixo',    // inválida → superfície fica DRAC
  });
  assert.ok(css);
  for (const v of ['--card:', '--popover:', '--secondary:', '--muted:', '--accent:', '--card-foreground:']) {
    assert.ok(!css!.includes(v), `superfície inválida não deve emitir ${v}`);
  }
});

test('buildBrandColorCss: paleta escura vai para .dark e é independente da clara', () => {
  const css = buildBrandColorCss({
    useDefaultColors: false,
    backgroundColor: '#14161b',      // fundo escuro
    borderColor: '#282d38',
  });
  assert.ok(css);
  assert.match(css!, new RegExp(`\\.dark\\{[^}]*--background:${hexToHslChannels('#14161b')!};`));
  assert.match(css!, new RegExp(`\\.dark\\{[^}]*--border:${hexToHslChannels('#282d38')!};`));
  assert.ok(!/:root\{/.test(css!), 'sem cores claras não deve emitir bloco :root');
});

test('buildBrandColorCss: paleta inteira vazia/padrão NÃO gera override (DRAC intocado)', () => {
  // Nenhum campo válido em nenhum tema → null.
  assert.equal(buildBrandColorCss({ useDefaultColors: false, lightBackgroundColor: '', backgroundColor: '  ', borderColor: 'nope' }), null);
  // useDefaultColors mesmo com paleta completa preenchida → null.
  assert.equal(buildBrandColorCss({
    useDefaultColors: true,
    lightBackgroundColor: '#ffffff', lightSurfaceColor: '#f3f5f9', lightBorderColor: '#d8dee8', lightPrimaryColor: '#0B6BD6',
  }), null);
});
