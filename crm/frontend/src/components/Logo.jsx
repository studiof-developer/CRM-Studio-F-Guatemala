import React from 'react';
import iconImg from '../assets/logo-icon.png';

export function Logo({ className = "w-48" }) {
  return (
    <div className={`flex items-center gap-[4%] ${className}`}>
      <img 
        src={iconImg} 
        alt="Bagneres CRM" 
        className="w-[36%] object-contain"
      />
      <div className="flex w-[60%] flex-col justify-center">
        <svg viewBox="0 0 140 56" className="w-full text-[#172554] dark:text-white overflow-visible drop-shadow-sm">
          <text x="0" y="24" fill="currentColor" className="font-sans font-bold" style={{ fontSize: '24px', letterSpacing: '0.02em' }}>BAGNERES</text>
          <text x="0" y="52" fill="currentColor" className="font-sans font-bold" style={{ fontSize: '24px', letterSpacing: '0.02em' }}>CRM</text>
        </svg>
      </div>
    </div>
  );
}
