import {setUpTest} from "./utils";
import {expect} from "chai";

describe("Blackbox testing OrderBook contract", async () => {
    it("Only owner can set min quote", async () => {
        const load = await setUpTest();
        await expect(load.OrderBookContract.connect(load.alice).setMinQuote(20))
            .to.not.reverted;
        expect(await load.OrderBookContract.minQuote()).eq(20);

        await expect(load.OrderBookContract.connect(load.bob).setMinQuote(30))
            .to.be.revertedWithCustomError(load.OrderBookContract, "OwnableUnauthorizedAccount");
    });

    it("Only owner can set fee", async () => {
        const load = await setUpTest();
        await expect(load.OrderBookContract.connect(load.alice).setFee(30, 20))
            .to.not.reverted;
        expect(await load.OrderBookContract.takerFeeBps()).eq(30);
        expect(await load.OrderBookContract.makerFeeBps()).eq(20);

        await expect(load.OrderBookContract.connect(load.bob).setFee(0, 0))
            .to.be.revertedWithCustomError(load.OrderBookContract, "OwnableUnauthorizedAccount");
    });
});