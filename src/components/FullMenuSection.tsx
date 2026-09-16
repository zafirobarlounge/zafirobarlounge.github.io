import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import type { HomeDictionary } from '../controllers/homeController';
import type { Locale } from '../models/business';
import {
  formatMenuPrice,
  getMenuAvailabilityLabel,
  getLocalizedCategoryLabel,
  getMenuItemDisplayDescription,
  getOrderedMenuCategories,
  groupMenuItemsByTypeAndSubgroup,
  isMenuItemAvailable,
  normalizeMenuCategory,
  resolveMenuImageSrc,
  sanitizeMenuText,
  type MenuCategory,
  type MenuDataItem,
} from '../models/menuData';
import { SectionHeading } from './SectionHeading';

interface FullMenuSectionProps {
  items: MenuDataItem[];
  dictionary: HomeDictionary;
  locale: Locale;
}

type MenuFilter = 'all' | MenuCategory;

export function FullMenuSection({ items, dictionary, locale }: FullMenuSectionProps) {
  const groupedItems = useMemo(() => groupMenuItemsByTypeAndSubgroup(items), [items]);
  const categories = useMemo(() => getOrderedMenuCategories(items), [items]);
  const [selectedCategory, setSelectedCategory] = useState<MenuFilter>('all');
  const [selectedSubgroup, setSelectedSubgroup] = useState<string>('all');

  useEffect(() => {
    if (selectedCategory === 'all') {
      return;
    }

    if (!categories.includes(selectedCategory)) {
      setSelectedCategory('all');
    }
  }, [categories, selectedCategory]);

  const availableSubgroups = useMemo(() => {
    if (selectedCategory === 'all') {
      return [];
    }

    return (groupedItems[selectedCategory] ?? []).map((group) => group.subgroup);
  }, [groupedItems, selectedCategory]);

  useEffect(() => {
    setSelectedSubgroup('all');
  }, [selectedCategory]);

  const visibleCategories = selectedCategory === 'all' ? categories : [selectedCategory];

  return (
    <section id="full-menu" className="mx-auto max-w-7xl px-5 py-12 sm:px-6 sm:py-24 lg:px-8 xl:max-w-[90rem] 2xl:px-10">
      <SectionHeading
        eyebrow={dictionary.fullMenu.eyebrow}
        title={dictionary.fullMenu.title}
        description={dictionary.fullMenu.description}
      />

      <div className="mt-8 rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-4 sm:mt-10 sm:p-5">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <p className="text-[0.68rem] uppercase tracking-[0.28em] text-cyanGlow/80">
              {dictionary.fullMenu.groupFilterLabel}
            </p>
            <div className="flex flex-wrap gap-2">
              <FilterPill
                active={selectedCategory === 'all'}
                onClick={() => setSelectedCategory('all')}
                label={dictionary.fullMenu.allFilter}
              />
              {categories.map((category) => (
                <FilterPill
                  key={category}
                  active={selectedCategory === category}
                  onClick={() => setSelectedCategory(category)}
                  label={getLocalizedCategoryLabel(category, locale)}
                />
              ))}
            </div>
          </div>

          {selectedCategory !== 'all' && availableSubgroups.length ? (
            <div className="flex flex-col gap-3 border-t border-white/10 pt-4">
              <p className="text-[0.68rem] uppercase tracking-[0.28em] text-amberGlow">
                {dictionary.fullMenu.subgroupFilterLabel}
              </p>
              <div className="flex flex-wrap gap-2">
                <FilterPill
                  active={selectedSubgroup === 'all'}
                  onClick={() => setSelectedSubgroup('all')}
                  label={dictionary.fullMenu.allFilter}
                />
                {availableSubgroups.map((subgroup) => (
                  <FilterPill
                    key={subgroup}
                    active={selectedSubgroup === subgroup}
                    onClick={() => setSelectedSubgroup(subgroup)}
                    label={subgroup}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-8 space-y-8 sm:mt-10 sm:space-y-10">
        {visibleCategories.map((category) => {
          const normalizedCategory = normalizeMenuCategory(category);
          const categoryGroups = groupedItems[normalizedCategory] ?? [];
          const filteredGroups =
            selectedSubgroup === 'all'
              ? categoryGroups
              : categoryGroups.filter((group) => group.subgroup === selectedSubgroup);

          if (!filteredGroups.length) {
            return null;
          }

          return (
            <section
              key={normalizedCategory}
              className="rounded-[1.9rem] border border-white/10 bg-white/[0.03] p-4 sm:p-6 xl:p-7"
            >
              <div className="flex flex-col gap-3 border-b border-white/10 pb-4 sm:flex-row sm:items-end sm:justify-between sm:pb-5">
                <div>
                  <p className="text-[0.68rem] uppercase tracking-[0.28em] text-cyanGlow/80">
                    {dictionary.fullMenu.categoryEyebrow}
                  </p>
                  <h3 className="mt-2 font-display text-[2rem] text-ivory sm:text-[2.4rem]">
                    {getLocalizedCategoryLabel(normalizedCategory, locale)}
                  </h3>
                </div>
                <span className="w-fit rounded-full border border-white/10 bg-obsidian/45 px-3 py-1.5 text-[0.68rem] uppercase tracking-[0.24em] text-amberGlow">
                  {filteredGroups.reduce((total, group) => total + group.items.length, 0)}{' '}
                  {locale === 'es' ? 'opciones' : 'items'}
                </span>
              </div>

              <div className="mt-5 space-y-5">
                {filteredGroups.map((group) => (
                  <div key={`${normalizedCategory}-${group.subgroup}`} className="space-y-4">
                    <div className="flex items-center gap-3">
                      <span className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
                      <p className="text-[0.68rem] uppercase tracking-[0.24em] text-mist">
                        {group.subgroup}
                      </p>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {group.items.map((item, index) => (
                        <motion.article
                          key={`${normalizedCategory}-${group.subgroup}-${item.slug}`}
                          initial={{ opacity: 0, y: 18 }}
                          whileInView={{ opacity: 1, y: 0 }}
                          viewport={{ once: true, amount: 0.12 }}
                          transition={{ duration: 0.45, delay: index * 0.02 }}
                          className="interactive-card group relative overflow-hidden rounded-[1.6rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(7,10,18,0.94))] shadow-[0_14px_34px_rgba(0,0,0,0.22)]"
                        >
                          {item.imagen ? (
                            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                              <img
                                src={resolveMenuImageSrc(item.imagen)}
                                alt=""
                                aria-hidden="true"
                                className="absolute inset-0 h-full w-full scale-110 object-cover opacity-[0.12] blur-2xl saturate-[0.9]"
                              />
                              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(36,107,255,0.12),_transparent_30%),linear-gradient(180deg,rgba(8,10,18,0.18),rgba(7,10,18,0.78)_58%,rgba(7,10,18,0.96)_100%)]" />
                            </div>
                          ) : null}
                          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(36,107,255,0.12),_transparent_34%)] opacity-80" />
                          {item.imagen ? (
                            <div className="relative aspect-[1/1.02] overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(36,107,255,0.12),_transparent_40%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] px-2 pt-2 sm:px-3 sm:pt-3">
                              <img
                                src={resolveMenuImageSrc(item.imagen)}
                                alt={`${sanitizeMenuText(item.name)} menu item`}
                                loading="lazy"
                                className="h-full w-full object-contain object-center drop-shadow-[0_22px_28px_rgba(0,0,0,0.28)] transition duration-500 group-hover:scale-[1.015]"
                              />
                              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_transparent_50%,rgba(4,6,12,0.16)_100%)]" />
                              <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-b from-transparent via-midnight/18 to-obsidian/95" />
                              <div className="absolute inset-0 shadow-[inset_0_-52px_74px_rgba(4,6,12,0.52),inset_0_0_42px_rgba(0,0,0,0.1)]" />
                            </div>
                          ) : (
                            <div className="bg-[radial-gradient(circle_at_top_left,_rgba(36,107,255,0.16),_transparent_40%),rgba(255,255,255,0.03)] px-4 py-4">
                              <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">
                                {getLocalizedCategoryLabel(normalizedCategory, locale)}
                              </p>
                            </div>
                          )}

                          <div className="relative -mt-7 rounded-t-[1.5rem] bg-gradient-to-b from-obsidian/84 via-obsidian/95 to-obsidian p-4 before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/8 before:to-transparent sm:-mt-8 sm:p-5">
                            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.02),_transparent_48%)]" />
                            <div className="flex items-start justify-between gap-3">
                              <h4 className="font-display text-[1.7rem] leading-tight text-ivory sm:text-[1.9rem]">
                                {sanitizeMenuText(item.name)}
                              </h4>
                              <div className="flex flex-col items-end gap-2">
                                {!isMenuItemAvailable(item) ? (
                                  <span className="rounded-full border border-rose-200/20 bg-rose-200/10 px-3 py-1.5 text-[0.64rem] font-semibold uppercase tracking-[0.18em] text-rose-100">
                                    {getMenuAvailabilityLabel(locale)}
                                  </span>
                                ) : null}
                                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-amberGlow">
                                  {formatMenuPrice(item.precioVenta)}
                                </span>
                              </div>
                            </div>

                            {getMenuItemDisplayDescription(item) ? (
                              <p className="mt-3 text-sm leading-6 text-mist">
                                {getMenuItemDisplayDescription(item)}
                              </p>
                            ) : null}
                          </div>
                        </motion.article>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

interface FilterPillProps {
  active: boolean;
  label: string;
  onClick: () => void;
}

function FilterPill({ active, label, onClick }: FilterPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`interactive-button rounded-full border px-3 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.22em] transition sm:px-4 ${
        active
          ? 'border-cyanGlow/45 bg-cyanGlow/12 text-ivory'
          : 'border-white/10 bg-white/[0.03] text-mist hover:border-cyanGlow/30 hover:text-ivory'
      }`}
    >
      {label}
    </button>
  );
}
