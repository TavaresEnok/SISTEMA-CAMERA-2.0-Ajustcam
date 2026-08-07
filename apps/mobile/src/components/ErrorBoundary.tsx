import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type Props = {
  children: ReactNode;
  /**
   * Troca de valor = a barreira volta a renderizar os filhos.
   *
   * Usada por aba: sem isso, um crash numa tela deixava o app inteiro na tela
   * de recuperação — inclusive derrubando a live que o operador estava
   * assistindo por causa de um bug num card da Revisão. Com a chave, trocar de
   * aba já limpa o erro daquela tela.
   */
  resetKey?: string | number;
};

type State = {
  error: Error | null;
};

/**
 * Barreira de erro de render. Sem ela, qualquer exceção durante o render deixa o
 * app numa tela branca/preta sem saída. Aqui capturamos, mostramos uma tela de
 * recuperação e um botão "Tentar de novo" que remonta a árvore. Cores fixas
 * (não usa o ThemeProvider) de propósito: o próprio tema pode ser o que quebrou.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  componentDidUpdate(anterior: Props) {
    if (this.state.error && anterior.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Mantém visível no logcat/metro para diagnóstico.
    console.error('[ErrorBoundary] render falhou:', error);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <Text style={styles.emoji}>⚠️</Text>
          <Text style={styles.title}>Algo deu errado</Text>
          <Text style={styles.message}>
            O app encontrou um erro inesperado. Você pode tentar recarregar a tela.
          </Text>
          <Text style={styles.detail} numberOfLines={3}>
            {this.state.error.message}
          </Text>
          <Pressable style={styles.button} onPress={this.reset}>
            <Text style={styles.buttonText}>Tentar de novo</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#070809',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  emoji: { fontSize: 44, marginBottom: 12 },
  title: { color: '#E6E9EF', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  message: { color: '#9BA1AC', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  detail: {
    color: '#6B7280',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 14,
    fontStyle: 'italic',
  },
  button: {
    marginTop: 24,
    backgroundColor: '#4D93F0',
    paddingHorizontal: 26,
    paddingVertical: 12,
    borderRadius: 12,
  },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
