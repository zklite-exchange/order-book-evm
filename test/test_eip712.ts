import {setUpTest} from "./utils";
import {expect} from "chai";
import {anyValue} from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import {OrderSide, signSubmitOrder, TimeInForce} from "../index";

describe("OrderBook - Blackbox testing EIP712 features", async () => {
    it("Test submit order on behalf of user", async () => {
        const load = await setUpTest();
        const price = load.fmtPrice(1);
        const amount = load.fmtUsdc(10);
        const side = OrderSide.BUY;
        const validUntil = await load.expireAfter(7, "days");
        const networkFee = load.fmtUsdc(1);
        const nonce = 1;
        const pairId = load.defaultPairId;
        const tif = TimeInForce.GTC;

        const bobSignature = await signSubmitOrder({
            signer: load.bob,
            contract: load.OrderBookContract,
            side: side,
            price: price,
            amount: amount,
            pairId: pairId,
            validUntil: validUntil,
            tif: tif,
            networkFee: networkFee,
            nonce: nonce,
            orderIdsToCancel: []
        });

        await load.USDC.connect(load.bob).approve(load.OrderBookContract, load.uintMax);

        // use signature of bob, but submit on behalf of admin should fail because signature mismatch
        await expect(
            load.OrderBookContract.connect(load.alice)
                .submitOrderOnBehalfOf(
                    load.admin.address,
                    side, price, amount, pairId, validUntil,
                    tif, networkFee, nonce, [], [],
                    bobSignature
                )
        ).to.be.revertedWith("Invalid signature");

        // alice submit order on behalf of bob, should success
        await expect(
            load.OrderBookContract.connect(load.alice)
                .submitOrderOnBehalfOf(
                    load.bob.address,
                    side, price, amount, pairId, validUntil,
                    tif, networkFee, nonce, [], [],
                    bobSignature
                )
        ).to.emit(load.OrderBookContract, "NewOrderEvent")
            .withArgs(anyValue, load.bob.address, price, amount, pairId, side, validUntil);

        // use the same signature, submit again should be fail, nonce is used
        await expect(
            load.OrderBookContract.connect(load.alice)
                .submitOrderOnBehalfOf(
                    load.bob.address,
                    side, price, amount, pairId, validUntil,
                    tif, networkFee, nonce, [], [],
                    bobSignature
                )
        ).to.be.revertedWith("Nonce is used");
    });
});
