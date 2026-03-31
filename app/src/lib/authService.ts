import { hasSupabaseEnv, supabase } from './supabase';

export type AdminAuthState = {
  ready: boolean;
  loggedIn: boolean;
  isAdmin: boolean;
  email: string;
};

const LEGACY_ADMIN_SESSION_KEY = 'iekei-admin-auth';
const ADMIN_TABLE_NAME = 'admin_users';

export function isLegacyAdminAuthenticated() {
  return localStorage.getItem(LEGACY_ADMIN_SESSION_KEY) === 'true';
}

export async function getAdminAuthState(): Promise<AdminAuthState> {
  if (!hasSupabaseEnv || !supabase) {
    return {
      ready: true,
      loggedIn: isLegacyAdminAuthenticated(),
      isAdmin: isLegacyAdminAuthenticated(),
      email: isLegacyAdminAuthenticated() ? 'legacy-admin@example.com' : '',
    };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const user = userData.user;

  if (!user) {
    return { ready: true, loggedIn: false, isAdmin: false, email: '' };
  }

  const { data, error } = await supabase
    .from(ADMIN_TABLE_NAME)
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) throw error;

  return {
    ready: true,
    loggedIn: true,
    isAdmin: Boolean(data),
    email: user.email ?? '',
  };
}

export async function signInAdmin(email: string, password: string) {
  if (!hasSupabaseEnv || !supabase) {
    if (email === 'admin' && password === '1234') {
      localStorage.setItem(LEGACY_ADMIN_SESSION_KEY, 'true');
      return;
    }
    throw new Error('メールアドレスまたはパスワードが違います。');
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;

  const state = await getAdminAuthState();
  if (!state.isAdmin) {
    await supabase.auth.signOut();
    throw new Error('ログインは成功しましたが、管理者として登録されていないため管理画面は使えません。');
  }
}

export async function signOutAdmin() {
  if (!hasSupabaseEnv || !supabase) {
    localStorage.removeItem(LEGACY_ADMIN_SESSION_KEY);
    return;
  }
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
