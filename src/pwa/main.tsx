import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RequestLanding } from './pages/RequestLanding';
import { MyRequests } from './pages/MyRequests';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/request" element={<RequestLanding />} />
        <Route path="/my-requests" element={<MyRequests />} />
        <Route path="*" element={<Navigate to="/my-requests" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
