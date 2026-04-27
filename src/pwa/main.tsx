import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RequestLanding } from './pages/RequestLanding';
import { Feed } from './pages/Feed';
import { Saved } from './pages/Saved';
import { Admin } from './pages/Admin';
import { Watch } from './pages/Watch';
import { Search } from './pages/Search';
import { Profile } from './pages/Profile';
import { Person } from './pages/Person';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/request"   element={<RequestLanding />} />
          <Route path="/feed"      element={<Feed />} />
          <Route path="/saved"     element={<Saved />} />
          <Route path="/admin"     element={<Admin />} />
          <Route path="/watch/:requestId" element={<Watch />} />
          <Route path="/search"    element={<Search />} />
          <Route path="/profile"   element={<Profile />} />
          <Route path="/person/:personId" element={<Person />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
