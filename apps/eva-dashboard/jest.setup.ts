import '@testing-library/jest-dom';

// Next.js navigation mock
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/tasks',
  useSearchParams: () => new URLSearchParams(),
  redirect: jest.fn(),
}));

// next/headers mock (server components)
jest.mock('next/headers', () => ({
  cookies: () => ({
    getAll: () => [],
    set: jest.fn(),
    get: jest.fn(),
  }),
}));
