import { Request } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      id: string;
      email: string;
      name: string;
      phone: string; // Tambahkan ini
      role: 'ADMIN' | 'SELLER' | 'BUYER';
    };
  }
}