import { useCallback, useState } from 'react';

import { GameScreen } from './components/game-screen';
import { LoginForm } from './components/login-form';
import { LabScreen } from './lab/lab-screen';
import { clearToken, loadToken, saveToken } from './token-storage';

export function App() {
  return window.location.pathname.startsWith('/lab') ? <LabScreen /> : <Game />;
}

function Game() {
  const [token, setToken] = useState<string | null>(loadToken);

  const logIn = useCallback((newToken: string) => {
    saveToken(newToken);
    setToken(newToken);
  }, []);

  const logOut = useCallback(() => {
    clearToken();
    setToken(null);
  }, []);

  return token ? <GameScreen token={token} onLogout={logOut} /> : <LoginForm onLogin={logIn} />;
}
