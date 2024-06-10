import {setUpTest} from "./utils";
import {expect} from "chai";
import BN from "bignumber.js";

describe("OrderBook - Blackbox testing admin config", async () => {
    it("Test create pair", async () => {
        const load = await setUpTest();
        const priceDecimals = 21;
        const minExecuteQuote = load.fmtWeth(10);
        const minQuoteChargeFee = load.fmtWeth(20);
        const takerFeeBps = 100;
        const makerFeeBps = 100;
        const base = load.usdcAddress; const quote = load.wethAddress;
        let pairId = 0n;
        await expect(
            load.OrderBookContract.connect(load.admin)
                .createPair(base, quote, priceDecimals, minExecuteQuote, minQuoteChargeFee, takerFeeBps, makerFeeBps)
        ).to.be.emit(load.OrderBookContract, "NewPairConfigEvent")
            .withArgs(
                base, quote, minExecuteQuote, minQuoteChargeFee,
                (id: bigint) => {pairId = id; return true;},
                takerFeeBps, makerFeeBps, priceDecimals, true
            );
        expect(pairId).gt(0);

        const pair = await load.OrderBookContract.getPair(pairId);
        expect(pair.id).eq(pairId);
        expect(pair.baseToken).eq(base);
        expect(pair.quoteToken).eq(quote);
        expect(pair.minExecuteQuote).eq(minExecuteQuote);
        expect(pair.minQuoteChargeFee).eq(minQuoteChargeFee);
        expect(pair.takerFeeBps).eq(takerFeeBps);
        expect(pair.makerFeeBps).eq(makerFeeBps);
        expect(pair.active).eq(true);
    });

    it("Test change minQuote", async () => {
        const load = await setUpTest();
        await expect(load.OrderBookContract.connect(load.admin).setMinQuote(load.defaultPairId, 20, 30))
            .to.be.emit(load.OrderBookContract, "NewPairConfigEvent")
            .withArgs(
                load.wethAddress, load.usdcAddress, 20, 30,
                load.defaultPairId, load.takerFeeBps, load.makerFeeBps,
                (decimals: bigint) => new BN(load.priceDecimalPow).eq((10n**decimals).toString()),
                true
            );
        const pairConf = await load.OrderBookContract.getPair(load.defaultPairId);
        expect(pairConf.minExecuteQuote).eq(20);
        expect(pairConf.minQuoteChargeFee).eq(30);
    });

    it("Test change fee", async () => {
        const load = await setUpTest();
        await expect(load.OrderBookContract.connect(load.admin).setFee(load.defaultPairId, 20, 30))
            .to.be.emit(load.OrderBookContract, "NewPairConfigEvent")
            .withArgs(
                load.wethAddress, load.usdcAddress, load.minExecuteQuote, load.minQuoteChargeFee,
                load.defaultPairId, 20, 30,
                (decimals: bigint) => new BN(load.priceDecimalPow).eq((10n**decimals).toString()),
                true
            );
        const pairConf = await load.OrderBookContract.getPair(load.defaultPairId);
        expect(pairConf.takerFeeBps).eq(20);
        expect(pairConf.makerFeeBps).eq(30);
    });

    it("Test change pair active status", async () => {
        const load = await setUpTest();
        await expect(load.OrderBookContract.connect(load.admin).setPairActive(load.defaultPairId, false))
            .to.be.emit(load.OrderBookContract, "NewPairConfigEvent")
            .withArgs(
                load.wethAddress, load.usdcAddress, load.minExecuteQuote, load.minQuoteChargeFee,
                load.defaultPairId, load.takerFeeBps, load.makerFeeBps,
                (decimals: bigint) => new BN(load.priceDecimalPow).eq((10n**decimals).toString()),
                false
            );
        const pairConf = await load.OrderBookContract.getPair(load.defaultPairId);
        expect(pairConf.active).eq(false);
    });

    it("Test change pair active status", async () => {
        const load = await setUpTest();
        const arr = [false, true];
        for (let i = 0; i < arr.length; i++) {
            const status = arr[i];
            await expect(load.OrderBookContract.connect(load.admin).setPairActive(load.defaultPairId, status))
                .to.be.emit(load.OrderBookContract, "NewPairConfigEvent")
                .withArgs(
                    load.wethAddress, load.usdcAddress, load.minExecuteQuote, load.minQuoteChargeFee,
                    load.defaultPairId, load.takerFeeBps, load.makerFeeBps,
                    (decimals: bigint) => new BN(load.priceDecimalPow).eq((10n**decimals).toString()),
                    status
                );
            const pairConf = await load.OrderBookContract.getPair(load.defaultPairId);
            expect(pairConf.active).eq(status);
        }
    });

    it("Test set admin", async () => {
        const load = await setUpTest();
        await expect(load.OrderBookContract.connect(load.admin).setAdmin(load.bob.address))
            .to.not.be.reverted;
        expect(await load.OrderBookContract.getAdmin()).eq(load.bob.address);
    });
});
