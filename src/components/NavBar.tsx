import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import zafiroLogoWhite from '../assets/zafiro-logo-white.png';
import type { HomeDictionary } from '../controllers/homeController';
import type { BusinessInfo, Locale } from '../models/business';

interface NavBarProps {
  business: BusinessInfo;
  dictionary: HomeDictionary;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  onMobileMenuChange?: (isOpen: boolean) => void;
  reserveLabel: string;
}

export function NavBar({
  business,
  dictionary,
  locale,
  onLocaleChange,
  onMobileMenuChange,
  reserveLabel,
}: NavBarProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const navItems = [
    { label: dictionary.nav.about, href: '#about' },
    { label: dictionary.nav.menu, href: '/menu', isRoute: true },
    { label: dictionary.nav.gallery, href: '#gallery' },
    { label: dictionary.nav.experience, href: '#experience' },
    { label: dictionary.nav.contact, href: '#contact' },
  ];

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [locale]);

  useEffect(() => {
    document.body.style.overflow = isMobileMenuOpen ? 'hidden' : '';
    onMobileMenuChange?.(isMobileMenuOpen);

    return () => {
      document.body.style.overflow = '';
      onMobileMenuChange?.(false);
    };
  }, [isMobileMenuOpen, onMobileMenuChange]);

  const closeMobileMenu = () => {
    setIsMobileMenuOpen(false);
  };

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-obsidian/65 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-6 lg:px-8">
        <a href="#home" className="interactive-button flex items-center gap-3 rounded-full text-ivory">
          <img
            src={zafiroLogoWhite}
            alt={`${business.name} logo`}
            className="h-10 w-auto object-contain sm:h-11"
          />
          <span className="hidden font-display text-2xl tracking-[0.18em] text-ivory sm:block">
            {business.shortName}
          </span>
        </a>
        <nav className="hidden items-center gap-6 text-sm text-mist md:flex">
          {navItems.map((item) => (
            item.isRoute ? (
              <Link key={item.label} to={item.href} className="interactive-link transition hover:text-ivory">
                {item.label}
              </Link>
            ) : (
              <a key={item.label} href={item.href} className="interactive-link transition hover:text-ivory">
                {item.label}
              </a>
            )
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <div className="hidden rounded-full border border-white/10 bg-white/5 p-1 md:flex">
            {(['en', 'es'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onLocaleChange(option)}
                className={`interactive-button rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.22em] transition ${
                  locale === option ? 'bg-ivory text-obsidian' : 'text-mist hover:text-ivory'
                }`}
              >
                {dictionary.languageToggle[option]}
              </button>
            ))}
          </div>
          <a
            href="#contact"
            className="interactive-button hidden rounded-full border border-sapphire/40 bg-sapphire/15 px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em] text-ivory transition hover:border-cyanGlow/50 hover:bg-sapphire/25 sm:block"
          >
            {reserveLabel}
          </a>
          <button
            type="button"
            aria-expanded={isMobileMenuOpen}
            aria-controls="mobile-navigation"
            aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setIsMobileMenuOpen((current) => !current)}
            className="interactive-button inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/5 text-ivory transition hover:border-cyanGlow/40 hover:bg-white/10 md:hidden"
          >
            <span className="relative h-4 w-5">
              <span
                className={`absolute left-0 top-0 h-0.5 w-5 rounded-full bg-current transition ${
                  isMobileMenuOpen ? 'translate-y-[7px] rotate-45' : ''
                }`}
              />
              <span
                className={`absolute left-0 top-[7px] h-0.5 w-5 rounded-full bg-current transition ${
                  isMobileMenuOpen ? 'opacity-0' : ''
                }`}
              />
              <span
                className={`absolute left-0 top-[14px] h-0.5 w-5 rounded-full bg-current transition ${
                  isMobileMenuOpen ? '-translate-y-[7px] -rotate-45' : ''
                }`}
              />
            </span>
          </button>
        </div>
      </div>

      <AnimatePresence>
        {isMobileMenuOpen ? (
          <>
            <motion.button
              key="mobile-menu-overlay"
              type="button"
              aria-label="Close menu overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={closeMobileMenu}
              className="fixed inset-0 z-40 bg-obsidian/55 backdrop-blur-sm md:hidden"
            />
            <motion.div
              key="mobile-menu"
              id="mobile-navigation"
              initial={{ opacity: 0, y: -18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14 }}
              transition={{ duration: 0.24, ease: 'easeOut' }}
              className="zafiro-dropdown-scroll absolute inset-x-4 top-full z-50 mt-3 rounded-[1.75rem] border border-white/10 bg-[linear-gradient(180deg,rgba(16,19,28,0.96),rgba(9,9,11,0.98))] p-4 shadow-glow [--zafiro-dropdown-top:5.625rem] md:hidden"
            >
              <div className="rounded-[1.4rem] border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-4 flex items-center justify-between gap-4 border-b border-white/10 pb-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyanGlow/80">
                      {businessLabel(dictionary, locale)}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-mist">{reserveLabel}</p>
                  </div>
                  <div className="flex rounded-full border border-white/10 bg-white/5 p-1">
                    {(['en', 'es'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => onLocaleChange(option)}
                        className={`interactive-button rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.22em] transition ${
                          locale === option ? 'bg-ivory text-obsidian' : 'text-mist hover:text-ivory'
                        }`}
                      >
                        {dictionary.languageToggle[option]}
                      </button>
                    ))}
                  </div>
                </div>

                <nav className="flex flex-col gap-2">
                  {navItems.map((item, index) => (
                    <motion.div
                      key={item.label}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.04 * index, duration: 0.22 }}
                    >
                      {item.isRoute ? (
                        <Link
                          to={item.href}
                          onClick={closeMobileMenu}
                          className="interactive-card flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm font-medium text-ivory transition hover:border-cyanGlow/30 hover:bg-white/[0.06]"
                        >
                          <span>{item.label}</span>
                          <span className="text-cyanGlow/75">/</span>
                        </Link>
                      ) : (
                        <a
                          href={item.href}
                          onClick={closeMobileMenu}
                          className="interactive-card flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-sm font-medium text-ivory transition hover:border-cyanGlow/30 hover:bg-white/[0.06]"
                        >
                          <span>{item.label}</span>
                          <span className="text-cyanGlow/75">/</span>
                        </a>
                      )}
                    </motion.div>
                  ))}
                </nav>

                <a
                  href="#contact"
                  onClick={closeMobileMenu}
                  className="interactive-button mt-4 inline-flex w-full items-center justify-center rounded-full border border-sapphire/40 bg-sapphire/15 px-4 py-3 text-xs font-semibold uppercase tracking-[0.25em] text-ivory transition hover:border-cyanGlow/50 hover:bg-sapphire/25"
                >
                  {reserveLabel}
                </a>
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </header>
  );
}

function businessLabel(dictionary: HomeDictionary, locale: Locale) {
  if (locale === 'es') {
    return 'Navegación';
  }

  return 'Navigation';
}
