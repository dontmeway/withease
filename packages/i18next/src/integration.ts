import {
  attach,
  combine,
  createEffect,
  createEvent,
  createStore,
  Event,
  is,
  sample,
  scopeBind,
  Store,
} from 'effector';
import { type TFunction, i18n } from 'i18next';

interface Translated {
  (key: string, variables?: Record<string, Store<string>>): Store<string>;
  (parts: TemplateStringsArray, ...stores: Array<Store<string>>): Store<string>;
}

type MissinKeyReport = {
  lngs: readonly string[];
  namespace: string;
  key: string;
  res: string;
};

type I18nextIntegration = {
  $t: Store<TFunction>;
  translated: Translated;
  $isReady: Store<boolean>;
  reporting: {
    missingKey: Event<MissinKeyReport>;
  };
};

const identity = ((key: string) => key) as TFunction;

export function createI18nextIntegration({
  instance,
  setup,
  teardown,
}: {
  instance: i18n | Store<i18n | null>;
  setup: Event<void>;
  teardown?: Event<void>;
}): I18nextIntegration {
  // -- Internval events
  const instanceInitialized = createEvent<i18n>();
  const contextChanged = createEvent();

  // -- Parse options
  const $instance: Store<i18n | null> = is.store(instance)
    ? instance
    : createStore(instance as i18n | null);

  const destroy = teardown ?? createEvent();

  // -- Internal API

  const $derivedT = $instance.map((i18next): TFunction | null =>
    i18next ? i18next.t.bind(i18next) : null
  );
  const $stanaloneT = createStore<TFunction | null>(null, {
    serialize: 'ignore',
  });

  // -- Public API
  const $isReady = createStore(false, { serialize: 'ignore' });

  const $t = combine(
    { derived: $derivedT, standalone: $stanaloneT },
    ({ derived, standalone }): TFunction => standalone ?? derived ?? identity
  );

  const reporting = {
    missingKey: createEvent<MissinKeyReport>(),
  };

  sample({
    clock: [
      instanceInitialized,
      sample({ clock: contextChanged, source: $instance, filter: Boolean }),
    ],
    fn: (i18next) => i18next.t.bind(i18next),
    target: $stanaloneT,
  });

  sample({
    clock: instanceInitialized,
    fn: () => true,
    target: $isReady,
  });

  sample({ clock: destroy, fn: () => false, target: $isReady });

  function translatedLiteral(
    parts: TemplateStringsArray,
    ...stores: Array<Store<string>>
  ): Store<string> {
    return combine(
      { t: $t, dynamicParts: combine(stores) },
      ({ t, dynamicParts }) => {
        const result = [] as string[];

        parts.forEach((part, i) => {
          const resolved = dynamicParts[i];

          result.push(part, resolved ?? '');
        });

        const finalKey = result.join('');

        return t(finalKey);
      }
    );
  }

  function translatedWithVariables(
    key: string,
    variables?: Record<string, Store<string>>
  ): Store<string> {
    return combine(
      { t: $t, variables: combine(variables ?? {}) },
      ({ t, variables }) => t(key, variables)
    );
  }

  // -- Setup

  const initInstanceFx = attach({
    source: $instance,
    async effect(i18next) {
      if (!i18next) {
        return null;
      }

      // Subscribe to missing key event BEFORE init
      const boundMissingKey = scopeBind(reporting.missingKey, { safe: true });
      const missingKeyListener = (
        lngs: readonly string[],
        namespace: string,
        key: string,
        res: string
      ) => boundMissingKey({ lngs, namespace, key, res });
      i18next.on('missingKey', missingKeyListener);

      if (i18next.isInitialized) {
        return { i18next, missingKeyListener };
      }

      await i18next.init();
      return { i18next, missingKeyListener };
    },
  });

  const $contextChangeListener = createStore<(() => void) | null>(null, {
    serialize: 'ignore',
  });

  const $missingKeyListener = createStore<(() => void) | null>(null, {
    serialize: 'ignore',
  });

  const setupListenersFx = createEffect((i18next: i18n) => {
    // Context change
    const boundContextChanged = scopeBind(contextChanged, { safe: true });
    const contextChangeListener = () => boundContextChanged();

    i18next.on('languageChanged', contextChangeListener);
    i18next.store.on('added', contextChangeListener);

    // Result
    return { contextChangeListener };
  });

  const destroyListenersFx = attach({
    source: {
      contextChangeListener: $contextChangeListener,
      missingKeyListener: $missingKeyListener,
      i18next: $instance,
    },
    effect: ({ contextChangeListener, missingKeyListener, i18next }) => {
      if (!i18next) {
        return;
      }

      if (contextChangeListener) {
        i18next.off('languageChanged', contextChangeListener);
        i18next.store.off('added', contextChangeListener);
      }

      if (missingKeyListener) {
        i18next.off('missingKey', missingKeyListener);
      }
    },
  });

  sample({ clock: [setup, $instance.updates], target: initInstanceFx });
  sample({
    clock: initInstanceFx.doneData,
    filter: Boolean,
    fn: ({ i18next }) => i18next,
    target: [instanceInitialized, setupListenersFx],
  });

  sample({
    clock: setupListenersFx.doneData,
    fn: ({ contextChangeListener }) => contextChangeListener,
    target: $contextChangeListener,
  });
  sample({
    clock: initInstanceFx.doneData,
    filter: Boolean,
    fn: ({ missingKeyListener }) => missingKeyListener,
    target: $missingKeyListener,
  });
  sample({ clock: destroy, target: destroyListenersFx });
  sample({
    clock: destroyListenersFx.done,
    target: [$contextChangeListener.reinit!, $missingKeyListener.reinit!],
  });

  return {
    $isReady,
    $t,
    translated: (firstArg, ...args: any[]) => {
      if (typeof firstArg === 'string') {
        return translatedWithVariables(firstArg, args[0]);
      } else {
        return translatedLiteral(firstArg, ...args);
      }
    },
    reporting,
  };
}
