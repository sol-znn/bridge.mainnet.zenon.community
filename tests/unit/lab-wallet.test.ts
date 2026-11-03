import { expect, it } from 'vitest'
import { Account } from '../../e2e/lib/wallet.ts'

const DEV_MNEMONIC =
  'abstract affair idle position alien fluid board ordinary exist afraid chapter wood wood guide sun walnut crew perfect place firm poverty model side million'

it('derives the lab administrator from the devnet mnemonic', () => {
  expect(Account.fromMnemonic(DEV_MNEMONIC, 1).address).toBe('z1qq6eg8n43g032hanpsfp02qcdmv7zfj3y2lt5d')
})

it('normalises whitespace and refuses an invalid mnemonic', () => {
  expect(Account.fromMnemonic(`  ${DEV_MNEMONIC.replaceAll(' ', '\n ')} `, 1).address)
    .toBe('z1qq6eg8n43g032hanpsfp02qcdmv7zfj3y2lt5d')
  expect(() => Account.fromMnemonic(DEV_MNEMONIC.replace('million', 'abstract'))).toThrow('not valid BIP-39')
})
